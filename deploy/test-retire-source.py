"""Verify that retirement touches only the chess route, cron block and keys."""
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        app = root / 'app'
        tools = root / 'tools'
        app.mkdir()
        tools.mkdir()
        route = root / 'htaccess'
        route.write_text('Options -Indexes\nRewriteRule ^(.*)$ http://127.0.0.1:18082/$1 [P,L]\n# keep\n')
        keys = root / 'authorized_keys'
        keys.write_text('ssh-ed25519 original owner-key\nssh-ed25519 a kamkmchess-target-tunnel\nssh-ed25519 b kamkmchess-migration\n')
        cron = root / 'crontab'
        cron.write_text('* * * * * other-job\n# BEGIN kamkmchess operations\n17 3 * * * chess-backup\n# END kamkmchess operations\n')
        executable(tools / 'docker', '#!/bin/sh\nexit 0\n')
        executable(tools / 'crontab', '#!/bin/sh\nif [ "$1" = -l ]; then cat "$TEST_CRON"; else cat > "$TEST_CRON"; fi\n')
        source = Path(__file__).with_name('retire-source.py').read_text()
        source = source.replace('/home/agentsoftmagic/kamkmchess', str(app))
        source = source.replace('/home/agentsoftmagic/public_html/chess-api/.htaccess', str(route))
        source = source.replace('/home/agentsoftmagic/.ssh/authorized_keys', str(keys))
        script = root / 'retire.py'
        script.write_text(source)
        env = {**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}', 'TEST_CRON': str(cron)}
        subprocess.run(['python3', str(script)], env=env, check=True, capture_output=True)
        assert route.read_text() == 'Options -Indexes\n# keep\n'
        assert keys.read_text() == 'ssh-ed25519 original owner-key\n'
        assert cron.read_text() == '* * * * * other-job\n'
    print('Source retirement checks passed.')


def executable(path, content):
    path.write_text(content)
    path.chmod(0o700)


if __name__ == '__main__':
    main()
