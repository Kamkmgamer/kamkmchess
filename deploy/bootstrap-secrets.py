"""Create server-only credentials once, without displaying their values."""
import os
from pathlib import Path
import secrets


def main():
    directory = Path(__file__).resolve().parent
    values = {
        'postgres.env': ('POSTGRES_DB=kamkmchess\n'
                         'POSTGRES_USER=kamkmchess_migrator\n'
                         'POSTGRES_PASSWORD=' + secrets.token_hex(32) + '\n'),
        'backup.env': 'KHA_BACKUP_PASSPHRASE=' + secrets.token_hex(32) + '\n',
    }
    for name, value in values.items():
        target = directory / name
        if target.exists():
            continue
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(value)
    print('Server credentials ready')


if __name__ == '__main__':
    main()
