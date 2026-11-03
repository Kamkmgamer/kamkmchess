"""Stop only the old chess services after the DNS grace period."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path('/home/agentsoftmagic/kamkmchess')
route = Path('/home/agentsoftmagic/public_html/chess-api/.htaccess')
keys = Path('/home/agentsoftmagic/.ssh/authorized_keys')
begin = '# BEGIN kamkmchess operations'
end = '# END kamkmchess operations'


def replace_file(path, content):
    mode = path.stat().st_mode & 0o777
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as output:
            output.write(content)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    os.chdir(root)
    if (root / '.target-cutover-pending').exists():
        raise SystemExit('A cutover is still pending.')
    old_route = route.read_text()
    line = 'RewriteRule ^(.*)$ http://127.0.0.1:18082/$1 [P,L]'
    if old_route.count(line) != 1:
        raise SystemExit('The old public route is not in the expected state.')
    old_keys = keys.read_text().splitlines(keepends=True)
    remaining = [line for line in old_keys if not line.rstrip().endswith((' kamkmchess-target-tunnel', ' kamkmchess-migration'))]
    if not remaining or len(remaining) != len(old_keys) - 2:
        raise SystemExit('The restricted SSH keys are not in the expected state.')
    cron = subprocess.run(['crontab', '-l'], check=True, capture_output=True, text=True).stdout
    if cron.count(begin) != 1 or cron.count(end) != 1 or cron.index(begin) >= cron.index(end):
        raise SystemExit('The chess backup cron block is not in the expected state.')
    start = cron.index(begin)
    finish = cron.index(end, start) + len(end)
    if finish < len(cron) and cron[finish] == '\n':
        finish += 1
    subprocess.run(['docker', 'compose', '-f', 'postgres.compose.yml', '-f', 'api.compose.yml',
                    'stop', 'api', 'postgres'], check=True)
    subprocess.run(['crontab', '-'], input=cron[:start] + cron[finish:], text=True, check=True)
    replace_file(route, old_route.replace(line + '\n', '', 1))
    replace_file(keys, ''.join(remaining))
    print('Old chess backend retired.')


if __name__ == '__main__':
    main()
