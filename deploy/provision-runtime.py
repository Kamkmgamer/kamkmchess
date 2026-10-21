"""Initialize only the dedicated chess database and its restricted runtime role.

The migration binary must already be in ./bin. Credentials are generated in
owner-only files and never printed. Run from the server deployment directory.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.parse


COMPOSE = ['docker', 'compose', '-f', 'postgres.compose.yml']


def sql(statement, database='kamkmchess'):
    result = subprocess.run(
        COMPOSE + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                   '-U', 'kamkmchess_migrator', '-d', database, '-At'],
        input=statement.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError('Database provisioning SQL failed; inspect privately')
    return result.stdout.decode().strip()


def role_exists(name):
    """Reports whether a database role exists."""
    return sql("SELECT 1 FROM pg_roles WHERE rolname='" + name + "'") == '1'


def main():
    os.chdir(Path(__file__).resolve().parent)
    if sql("SELECT 1 FROM pg_database WHERE datname='kamkmchess'", 'postgres') != '1':
        sql('CREATE DATABASE kamkmchess OWNER kamkmchess_migrator', 'postgres')
    subprocess.run(COMPOSE + ['exec', '-T', '-e',
        'DATABASE_URL=postgres:///kamkmchess?host=/var/run/postgresql&user=kamkmchess_migrator',
        'postgres', '/opt/kamkmchess/kamkmchess-migrate'], check=True)
    runtime = Path('runtime.env')
    if not runtime.exists():
        password = secrets.token_hex(32)
        sql("CREATE ROLE kamkmchess_runtime LOGIN NOSUPERUSER NOCREATEDB "
            "NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 48 "
            "PASSWORD '" + password + "'")
        query = urllib.parse.urlencode({
            'sslmode': 'verify-full', 'sslrootcert': 'system',
            'connect_timeout': '5', 'pool_max_conns': '4',
            'pool_min_conns': '0', 'pool_max_conn_idle_time': '30s'})
        url = ('postgres://kamkmchess_runtime:' + password +
               '@chess-db.agent.soft-magic.com:5432/kamkmchess?' + query)
        descriptor = os.open(runtime, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write('DATABASE_URL=' + url + '\n')
    api_env = Path('api.env')
    if not api_env.exists():
        database_url = runtime.read_text().strip().split('=', 1)[1]
        issuer = 'https://clerk.chess.khalil.mageed.net'
        origins = 'https://chess.khalil.mageed.net,https://kamkmchess.vercel.app'
        settings = {
            'DATABASE_URL': database_url, 'API_LISTEN_ADDR': ':8080',
            'CLERK_ISSUER': issuer, 'CLERK_JWKS_URL': issuer + '/.well-known/jwks.json',
            'CLERK_AUTHORIZED_PARTIES': origins, 'APP_ALLOWED_ORIGINS': origins,
        }
        descriptor = os.open(api_env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(''.join(key + '=' + value + '\n' for key, value in settings.items()))
    sql('''
REVOKE ALL ON DATABASE kamkmchess FROM PUBLIC;
GRANT CONNECT ON DATABASE kamkmchess TO kamkmchess_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kamkmchess_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
''')
    # The runtime grants come from the reviewed policy. Every table is listed
    # explicitly, so a later migration cannot widen the role by accident and a
    # removed table cannot keep a stale grant.
    policy = json.loads(Path('runtime-grants.policy.json').read_text())
    if policy.get('role') != 'kamkmchess_runtime':
        raise RuntimeError('Runtime grant policy names an unexpected role')
    statements = []
    for table, privileges in sorted(policy['privileges'].items()):
        if not table.replace('_', '').isalnum():
            raise RuntimeError('Runtime grant policy names an unexpected table')
        statements.append('REVOKE ALL ON TABLE public.' + table + ' FROM kamkmchess_runtime;')
        statements.append('GRANT ' + ', '.join(sorted(privileges)) +
                          ' ON TABLE public.' + table + ' TO kamkmchess_runtime;')
    sql('\n'.join(statements))
    # The online migrations create two more application roles and grant them
    # broad table privileges. The deployment connects as kamkmchess_runtime,
    # so those roles are unused and must not keep a grant. Provisioning strips
    # them, so no unused role can hold a privilege the policy does not grant.
    unused = [name for name in policy.get('unusedRoles', [])
              if role_exists(name)]
    if unused:
        revokes = []
        for role in unused:
            revokes.append('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ' + role + ';')
            revokes.append('REVOKE ALL ON SCHEMA public FROM ' + role + ';')
        sql('\n'.join(revokes))
    # A function that is not a trigger function can be called directly, and
    # PostgreSQL grants EXECUTE on it to PUBLIC. The deployment revokes that
    # and grants EXECUTE to the runtime role only.
    functions = sorted(policy.get('functions', {}))
    if functions:
        names = ', '.join("'" + name + "'" for name in functions)
        sql("""
DO $kamkmchess$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT p.oid::regprocedure::text AS signature
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname IN (""" + names + """) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', entry.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO kamkmchess_runtime', entry.signature);
  END LOOP;
END
$kamkmchess$;""")
    backup_env = Path('backup.env')
    if 'DATABASE_URL=' not in backup_env.read_text():
        settings = dict(line.split('=', 1) for line in Path('postgres.env').read_text().splitlines())
        backup_url = ('postgres://kamkmchess_migrator:' + settings['POSTGRES_PASSWORD'] +
                      '@127.0.0.1:5432/kamkmchess?sslmode=require')
        with backup_env.open('a') as output:
            output.write('DATABASE_URL=' + backup_url + '\n')
    print('Schema migrated; restricted runtime role ready')


if __name__ == '__main__':
    main()
