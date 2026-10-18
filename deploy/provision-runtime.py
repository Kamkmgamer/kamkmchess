"""Initialize only the dedicated chess database and its restricted runtime role.

The migration binary must already be in ./bin. Credentials are generated in
owner-only files and never printed. Run from the server deployment directory.
"""
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
GRANT USAGE ON SCHEMA public TO kamkmchess_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON games, archive_chunks, archive_events,
 operations, deletion_tombstones TO kamkmchess_runtime;
''')
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
