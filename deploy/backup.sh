#!/bin/sh
set -eu
cd "$(dirname "$0")"

# The durable evidence of the removals a restore owed lives next to the
# marker of the lifecycle, and the import of a restore destroys the removals
# it names. The evidence is copied into the protected backup with the very
# program the operator of a recovery uses, under the lock of the lifecycle
# and as the user that owns it, so the copy is never a half written record of
# a restore that is running. The destination is inside the directory of the
# bundles, so the copy is covered by this backup and it survives the
# recreation of the container.
#
# The exit codes of the program are the ones this procedure needs:
#
#   0   the evidence was copied, or there was nothing to copy
#   75  a restore holds the lock of the lifecycle: the copy is deferred to
#       the next run, the bundles are still backed up, and the deferral is
#       written to the log of the run
#   1   the copy failed for any other reason. The protected backup of the
#       evidence is then incomplete, so the **backup fails** and says so: a
#       missing mount, a wrong permission or a full disk must never be
#       reported as a complete protected backup.
copy_status=0
docker compose -f postgres.compose.yml exec -T postgres \
  sh /opt/kamkmchess-operator/copy-restore-evidence.sh /backups/restore-evidence || copy_status=$?
case "$copy_status" in
  0) ;;
  75)
    echo "a restore holds the lifecycle; the durable evidence was not copied and the next run of the backup copies it" >&2
    ;;
  *)
    echo "the durable evidence was not copied (status $copy_status); the protected backup of the evidence is incomplete" >&2
    exit "$copy_status"
    ;;
esac

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
