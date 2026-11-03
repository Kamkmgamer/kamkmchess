#!/bin/sh
# Restricted SSH entry point for the one-time move from the original host.
set -eu
cd /home/agentsoftmagic/kamkmchess
marker="$PWD/.target-cutover-pending"
htaccess=/home/agentsoftmagic/public_html/chess-api/.htaccess
compose='docker compose -f postgres.compose.yml -f api.compose.yml'

case "${SSH_ORIGINAL_COMMAND:-}" in
  status)
    if grep -q '127.0.0.1:18082/' "$htaccess"; then echo target; else echo source; fi
    ;;
  dump)
    test ! -e "$marker"
    grep -q '127.0.0.1:18081/' "$htaccess"
    ./backup.sh >&2
    : > "$marker"
    # If the transfer host disappears, restore the old service while the
    # public route still points to it. Never revive it after the route moved.
    nohup sh -c 'sleep 600; if [ -f "$1" ] && grep -q "127.0.0.1:18081/" "$2"; then cd "$3" && docker compose -f postgres.compose.yml -f api.compose.yml start api && rm -f "$1"; fi' -- "$marker" "$htaccess" "$PWD" </dev/null >/dev/null 2>&1 &
    $compose stop api >&2
    # A database dump alone cannot carry an in-progress restore fence or its
    # external deletion evidence. Refuse the cutover if either exists.
    fence=$(docker exec -u root kamkmchess-postgres-1 find /var/lib/kamkmchess/restore-fence -mindepth 1 ! -name restore-fence.lock -print -quit)
    evidence=$(docker exec -u root kamkmchess-postgres-1 find /backups/restore-evidence -mindepth 1 -print -quit)
    if [ -n "$fence" ] || [ -n "$evidence" ]; then
      echo 'Restore fence or deletion evidence requires manual migration.' >&2
      $compose start api >&2
      rm -f "$marker"
      exit 1
    fi
    if ! docker exec -u postgres kamkmchess-postgres-1 pg_dump -U kamkmchess_migrator -Fc --no-owner --no-acl kamkmchess; then
      $compose start api >&2 || true
      rm -f "$marker"
      exit 1
    fi
    ;;
  abort)
    if [ -e "$marker" ] && grep -q '127.0.0.1:18081/' "$htaccess"; then
      $compose start api >&2
      rm -f "$marker"
    fi
    ;;
  cutover)
    if grep -q '127.0.0.1:18082/' "$htaccess"; then rm -f "$marker"; exit 0; fi
    test -e "$marker"
    test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18082/v1/online/features)" = 200
    cp -p "$htaccess" "$htaccess.before-target"
    python3 -c 'import os, pathlib, tempfile; p=pathlib.Path("/home/agentsoftmagic/public_html/chess-api/.htaccess"); s=p.read_text(); old="http://127.0.0.1:18081/"; assert s.count(old)==1; fd,n=tempfile.mkstemp(dir=p.parent); os.fchmod(fd,p.stat().st_mode & 0o777); os.write(fd,s.replace(old,"http://127.0.0.1:18082/").encode()); os.close(fd); os.replace(n,p)'
    rm -f "$marker"
    ;;
  *) echo 'Unsupported operation' >&2; exit 2 ;;
esac
