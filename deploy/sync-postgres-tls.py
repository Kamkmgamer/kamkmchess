"""Copy the cPanel AutoSSL certificate into the dedicated PostgreSQL service.

Run as the cPanel account, from its deployment directory. The database key
never leaves the server. A daily cron invocation follows AutoSSL renewals.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


def run(*args, data=None):
    return subprocess.check_output(args, input=data, stderr=subprocess.PIPE)


def main():
    directory = Path(__file__).resolve().parent
    os.chdir(directory)
    hostname = 'chess-db.agent.soft-magic.com'
    result = json.loads(run('/usr/local/cpanel/bin/uapi', '--output=json',
                            'SSL', 'installed_hosts'))['result']
    if result['status'] != 1:
        raise RuntimeError('cPanel certificate lookup failed')
    host = next(item for item in result['data'] if hostname in item['domains'])
    certificate = host['certificate']
    if int(certificate['is_self_signed']):
        raise RuntimeError('A publicly trusted database certificate is required')
    home = Path.home()
    leaf = (home / 'ssl/certs' / (certificate['id'] + '.crt')).read_bytes().rstrip() + b'\n'
    public = run('openssl', 'x509', '-pubkey', '-noout', data=leaf)
    keys = [key for key in (home / 'ssl/keys').glob('*.key')
            if run('openssl', 'pkey', '-in', str(key), '-pubout') == public]
    if len(keys) != 1:
        raise RuntimeError('Cannot identify the database certificate key')
    tls = directory / 'tls'
    tls.mkdir(mode=0o755, exist_ok=True)
    chain_file = tls / 'issuer.pem'
    intermediates = b''
    current = leaf
    # Follow cross-signatures as well as the immediate issuer. New Let's
    # Encrypt intermediates can need a cross-signed root on older systems.
    for _ in range(5):
        aia = run('openssl', 'x509', '-noout', '-ext', 'authorityInfoAccess',
                  data=current).decode()
        issuer_url = re.search(r'CA Issuers - URI:(\S+)', aia)
        if issuer_url is None:
            raise RuntimeError('Cannot build a publicly trusted database chain')
        with urllib.request.urlopen(issuer_url.group(1), timeout=30) as response:
            issuer_der = response.read(128 * 1024)
        current = run('openssl', 'x509', '-inform', 'DER', '-outform', 'PEM',
                       data=issuer_der)
        intermediates += current
        chain_file.write_bytes(intermediates)
        verified = subprocess.run(
            ['openssl', 'verify', '-verify_hostname', hostname, '-untrusted',
             str(chain_file), '/dev/stdin'], input=leaf, capture_output=True)
        if verified.returncode == 0:
            break
    else:
        raise RuntimeError('Database certificate chain validation failed')
    chain = leaf + intermediates
    target = tls / 'server.crt'
    if target.exists() and target.read_bytes() == chain:
        print('PostgreSQL TLS certificate is current')
        return
    for name, value in [('server.crt', chain), ('server.key', keys[0].read_bytes())]:
        temporary = tls / (name + '.new')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(value)
        temporary.replace(tls / name)
    # postgres:16-alpine runs as UID 70. This only changes our own TLS files.
    run('docker', 'run', '--rm', '--user', '0', '-v', str(tls) + ':/tls',
        'postgres:16-alpine', 'sh', '-c',
        'chown 70:70 /tls/server.key; chmod 600 /tls/server.key; '
        'chmod 644 /tls/server.crt')
    running = run('docker', 'compose', '-f', 'postgres.compose.yml',
                  'ps', '--status', 'running', '-q', 'postgres').strip()
    if running:
        run('docker', 'compose', '-f', 'postgres.compose.yml', 'exec', '-T',
            'postgres', 'sh', '-c',
            'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT pg_reload_conf()"')
    print('PostgreSQL TLS certificate updated and verified')


if __name__ == '__main__':
    main()
