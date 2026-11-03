"""Move only the chess API A record using cPanel's serial-checked zone edit."""
import base64
import json
import subprocess
import sys
from urllib.parse import quote

ZONE = 'agent.soft-magic.com'
DESTINATION = '104.204.68.77'
SOURCE = '178.238.238.2'


def call(*args):
    data = json.loads(subprocess.check_output(['uapi', '--output=json', 'DNS', *args]))['result']
    return data


def main():
    if sys.argv[1:] not in (['--validate'], ['--apply']):
        raise SystemExit('Use --validate or --apply.')
    zone = call('parse_zone', f'zone={ZONE}')
    if not zone['status']:
        raise SystemExit('Could not read the DNS zone.')
    records = zone['data']
    soa = next(record for record in records if record.get('record_type') == 'SOA')
    serial = base64.b64decode(soa['data_b64'][2]).decode()
    matches = [record for record in records if record.get('dname_raw') == 'chess-api' and record.get('record_type') == 'A']
    if len(matches) != 1:
        raise SystemExit('The chess API must have exactly one A record.')
    current = base64.b64decode(matches[0]['data_b64'][0]).decode()
    if current == DESTINATION:
        print('The chess API A record already points to the target.')
        return
    if current != SOURCE:
        raise SystemExit('The API A record has an unexpected address; no changes made.')
    edit = {'line_index': matches[0]['line_index'], 'dname': 'chess-api', 'ttl': 300,
            'record_type': 'A', 'data': [DESTINATION]}
    result = call('mass_edit_zone', f'zone={ZONE}', f'serial={serial if sys.argv[1] == "--apply" else "0"}',
                  'edit=' + quote(json.dumps(edit, separators=(',', ':')), safe=''))
    if sys.argv[1] == '--validate':
        if result['status']:
            raise SystemExit('Unexpectedly accepted an invalid zone serial.')
        print('Validation rejected the stale serial:', '; '.join(result.get('errors') or []))
        return
    if not result['status']:
        raise SystemExit('DNS edit failed: ' + '; '.join(result.get('errors') or []))
    print('The chess API A record was updated.')


if __name__ == '__main__':
    main()
