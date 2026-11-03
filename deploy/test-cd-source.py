"""Exercise the source-side cutover with fake Docker and an isolated route."""
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
        route.write_text('RewriteRule ^(.*)$ http://127.0.0.1:18081/$1 [P,L]\n')
        log = root / 'docker.log'
        executable(tools / 'docker', '#!/bin/sh\necho "$*" >> "$TEST_DOCKER_LOG"\ncase "$*" in *pg_dump*) printf dump-data;; *find*restore-fence*) [ "${TEST_FENCE:-}" != 1 ] || printf pending;; esac\n')
        executable(tools / 'curl', '#!/bin/sh\nprintf 200\n')
        executable(tools / 'nohup', '#!/bin/sh\nexit 0\n')
        executable(app / 'backup.sh', '#!/bin/sh\nexit 0\n')
        script = Path(__file__).with_name('cd-source.sh').read_text()
        script = script.replace('/home/agentsoftmagic/kamkmchess', str(app))
        script = script.replace('/home/agentsoftmagic/public_html/chess-api/.htaccess', str(route))
        executable(app / 'source.sh', script)
        env = {**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}', 'TEST_DOCKER_LOG': str(log)}

        def run(command, success=True):
            result = subprocess.run([str(app / 'source.sh')], env={**env, 'SSH_ORIGINAL_COMMAND': command}, capture_output=True)
            assert (result.returncode == 0) == success, result.stderr.decode()
            return result.stdout

        assert run('status').strip() == b'source'
        blocked = subprocess.run([str(app / 'source.sh')], env={**env, 'SSH_ORIGINAL_COMMAND': 'dump', 'TEST_FENCE': '1'}, capture_output=True)
        assert blocked.returncode != 0 and blocked.stdout == b''
        assert not (app / '.target-cutover-pending').exists()
        assert run('dump') == b'dump-data'
        assert (app / '.target-cutover-pending').exists()
        run('abort')
        assert not (app / '.target-cutover-pending').exists()
        assert 'start api' in log.read_text()
        run('dump')
        run('cutover')
        assert run('status').strip() == b'target'
        assert not (app / '.target-cutover-pending').exists()
        before = log.read_text()
        run('abort')
        assert log.read_text() == before
        run('cutover')  # A lost reply can be retried.
        run('unknown', success=False)
    print('Source cutover and recovery checks passed.')


def executable(path, content):
    path.write_text(content)
    path.chmod(0o700)


if __name__ == '__main__':
    main()
