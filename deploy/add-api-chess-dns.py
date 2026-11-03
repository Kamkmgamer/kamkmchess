"""Add the API host to the app's DNS zone with a serial-checked edit."""
import base64
import json
import subprocess
import sys
from urllib.parse import quote

ZONE = 'khalil.mageed.net'
NAME = 'api.chess'
ADDRESS = '104.204.68.77'


def call(*args):
    return json.loads(subprocess.check_output(['uapi', '--output=json', 'DNS', *args]))['result']


def main():
    if sys.argv[1:] not in (['--validate'], ['--apply']):
        raise SystemExit('Use --validate or --apply.')
    zone = call('parse_zone', f'zone={ZONE}')
    if not zone['status']:
        raise SystemExit('Could not read the DNS zone.')
    records = zone['data']
    soa = next(record for record in records if record.get('record_type') == 'SOA')
    serial = base64.b64decode(soa['data_b64'][2]).decode()
    existing = [record for record in records if record.get('dname_raw') in (NAME, NAME + '.' + ZONE + '.')]
    if existing:
        if len(existing) == 1 and existing[0].get('record_type') == 'A' and base64.b64decode(existing[0]['data_b64'][0]).decode() == ADDRESS:
            print('The API host already points to the target.')
            return
        raise SystemExit('The API host has an existing record; no changes made.')
    record = {'dname': NAME, 'ttl': 300, 'record_type': 'A', 'data': [ADDRESS]}
    result = call('mass_edit_zone', f'zone={ZONE}', f'serial={serial if sys.argv[1] == "--apply" else "0"}',
                  'add=' + quote(json.dumps(record, separators=(',', ':')), safe=''))
    if sys.argv[1] == '--validate':
        if result['status']:
            raise SystemExit('Unexpectedly accepted an invalid zone serial.')
        print('Validation rejected the stale serial:', '; '.join(result.get('errors') or []))
        return
    if not result['status']:
        raise SystemExit('DNS edit failed: ' + '; '.join(result.get('errors') or []))
    print('The API host was added to the DNS zone.')


if __name__ == '__main__':
    main()
