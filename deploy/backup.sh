#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose -f postgres.compose.yml exec -T postgres sh -eu -c '
  set -a
  . /run/secrets/backup.env
  set +a
  for class in daily weekly; do
    if [ "$class" = daily ]; then label=$(date -u +daily-%Y-%m-%d); else label=$(date -u +weekly-%G-W%V); fi
    file="/backups/$label.kha"
    if [ "$class" = weekly ] && [ -f "$file" ]; then continue; fi
    /opt/kamkmchess/khabackup create --class "$class" --out "$file"
    /opt/kamkmchess/khabackup verify --file "$file"
    # The bundle is private to the user that restores it, and the restore
    # runs as the user the API reads the fence as. The bundle itself is
    # encrypted, so the file never carries a readable dump.
    chown 65532:65532 "$file"
    chmod 600 "$file"
  done
  /opt/kamkmchess/khabackup rotate --dir /backups --apply
'
