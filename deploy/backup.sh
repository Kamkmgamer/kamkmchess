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
    # The bundle is encrypted, so the file itself is not a secret: the
    # passphrase in backup.env is. The mode has to let the restore user read
    # the bundle, because the restore runs as the user the API reads the
    # fence as.
    chown 1043:1044 "$file"
    chmod 644 "$file"
  done
  /opt/kamkmchess/khabackup rotate --dir /backups --apply
'
