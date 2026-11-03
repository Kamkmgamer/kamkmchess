#!/bin/bash
set -Eeuo pipefail
release=${1:?release directory required}
cd /opt/kamkmchess/server
exec 9>/opt/kamkmchess/deploy.lock
flock -n 9 || { echo 'A deployment is already running.' >&2; exit 1; }
compose=(docker compose -f postgres.compose.yml -f api.compose.yml -f api-target.compose.yml)
source_ssh=(ssh -i /opt/kamkmchess/migration/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/kamkmchess/tunnel/known_hosts -p 9004 agentsoftmagic@mageed.net)
first=0
dump_file=
if [ ! -f .target-cutover-complete ]; then first=1; fi
cleanup() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$first" -eq 1 ]; then "${source_ssh[@]}" abort || true; fi
  if [ -n "$dump_file" ]; then rm -f "$dump_file"; fi
  exit "$code"
}
trap cleanup EXIT

if [ "$first" -eq 0 ]; then ./backup.sh; fi
test -f "$release/api.Dockerfile"
install -m 644 "$release/api.Dockerfile" api.Dockerfile
for file in kamkmchess-api kamkmchess-migrate khabackup khasuspend; do
  test -f "$release/bin/$file"
  install -m 755 "$release/bin/$file" "bin/$file"
done
for file in worker.mjs LICENSE.txt THIRD_PARTY_NOTICES.txt; do
  test -f "$release/rules-worker/$file"
  install -m 644 "$release/rules-worker/$file" "rules-worker/$file"
done
docker image tag kamkmchess-api:local kamkmchess-api:previous
"${compose[@]}" build api

if [ "$first" -eq 1 ]; then
  # The source freezes writes and starts a recovery watchdog before dumping.
  # No public traffic is moved until the clone, migrations and backup pass.
  umask 077
  dump_file=$(mktemp /opt/kamkmchess/source-dump.XXXXXXXX)
  "${source_ssh[@]}" dump > "$dump_file"
  "${compose[@]}" stop api
  docker exec -u postgres kamkmchess-postgres-1 dropdb -U kamkmchess_migrator --if-exists --force kamkmchess_incoming
  docker exec -u postgres kamkmchess-postgres-1 createdb -U kamkmchess_migrator -T template0 kamkmchess_incoming
  docker exec -i -u postgres kamkmchess-postgres-1 pg_restore -U kamkmchess_migrator --exit-on-error --no-owner --no-acl -d kamkmchess_incoming < "$dump_file"
  docker exec -u postgres kamkmchess-postgres-1 dropdb -U kamkmchess_migrator --if-exists --force kamkmchess_staging
  docker exec -u postgres kamkmchess-postgres-1 psql -X -v ON_ERROR_STOP=1 -U kamkmchess_migrator -d postgres -c 'ALTER DATABASE kamkmchess RENAME TO kamkmchess_staging'
  docker exec -u postgres kamkmchess-postgres-1 psql -X -v ON_ERROR_STOP=1 -U kamkmchess_migrator -d postgres -c 'ALTER DATABASE kamkmchess_incoming RENAME TO kamkmchess'
else
  "${compose[@]}" stop api
fi

# On failure the API stays stopped: a partially applied schema must not be
# served by either the old or new binary. The verified backup remains intact.
python3 provision-runtime.py
"${compose[@]}" up -d --no-deps --wait api
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/v1/online/features)" = 200

if [ "$first" -eq 1 ]; then
  # A weekly bundle from the empty standby must not mask the first live one.
  mkdir -p /opt/kamkmchess/standby-backups
  for file in backups/weekly-*.kha; do [ ! -e "$file" ] || mv "$file" /opt/kamkmchess/standby-backups/; done
  ./backup.sh
  # The source operation is idempotent if its reply is lost after switching.
  "${source_ssh[@]}" cutover || "${source_ssh[@]}" cutover
  : > .target-cutover-complete
fi
echo 'Backend deployment completed.'
