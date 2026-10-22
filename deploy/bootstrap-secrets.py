"""Create server-only credentials once, without displaying their values."""
import os
from pathlib import Path
import secrets
from urllib.parse import quote


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
            # A file that exists keeps its content, but it has to stay
            # private: the mode of an older file is tightened as well.
            os.chmod(target, 0o600)
            continue
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(value)

    # The restore command reads the database url and the passphrase from the
    # environment, and the private backup file is what carries them into the
    # container. The url is derived here and never displayed.
    backup = directory / 'backup.env'
    if backup.exists():
        current = backup.read_text()
        if 'DATABASE_URL=' not in current:
            postgres = dict(
                line.split('=', 1) for line in
                (directory / 'postgres.env').read_text().splitlines() if '=' in line
            )
            # A password can hold characters that are reserved in a url, so
            # the parts are escaped before they are joined.
            url = ('postgres://' + quote(postgres['POSTGRES_USER'], safe='') + ':' +
                   quote(postgres['POSTGRES_PASSWORD'], safe='') +
                   '@127.0.0.1:5432/' + quote(postgres['POSTGRES_DB'], safe='') +
                   '?sslmode=require')
            descriptor = os.open(backup, os.O_WRONLY | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, 'a') as output:
                if current and not current.endswith('\n'):
                    output.write('\n')
                output.write('DATABASE_URL=' + url + '\n')
            # Appending does not change the mode of the file, so the private
            # mode is set again.
            os.chmod(backup, 0o600)
    print('Server credentials ready')


if __name__ == '__main__':
    main()
