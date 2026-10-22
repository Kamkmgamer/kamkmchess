#!/bin/sh
# Copies the durable evidence of the owed removal ledgers into the protected
# backup of the deployment.
#
# The import of a restore replaces the schema of the target database, so the
# removals that only the live database carried are destroyed by the import
# itself. The durable evidence of those removals lives next to the marker of
# the lifecycle, and the copy of it is the artefact that survives the loss of
# the evidence directory.
#
# The copy is made under the operating system lock of the lifecycle and as
# the user that owns the lifecycle, so the copy is never a half written
# record of a restore that is running and the file of the lock carries the
# ownership and the mode the production code opens it with.
#
# The destination is inside the directory of the bundles, which is the bind
# mount of the deployment. The copy therefore survives the recreation of the
# container and it is covered by the backup of the deployment.
#
# The program runs inside the database container. The backup procedure and the
# runbook of the recovery run this very file, so the coverage of the backup is
# the coverage of the program that the proofs measure.
#
# The exit codes are the ones the caller needs:
#
#   0   the evidence was copied, or there was nothing to copy
#   75  a restore holds the lock of the lifecycle (EX_TEMPFAIL): the copy is
#       deferred to the next run and nothing is wrong with the deployment
#   1   the copy failed for any other reason: the destination is not usable,
#       the evidence could not be read or the copy could not be written. The
#       caller has to treat this as a failure of the backup, because the
#       protected backup of the evidence is then incomplete.
#
# Usage (inside the database container):
#   copy-restore-evidence.sh [destination]
#
# The parent directory of the fence is read from the environment of the
# container, exactly as the restore reads it.
set -eu

destination="${1:-/backups/restore-evidence}"
fence="${ONLINE_RESTORE_FENCE_PATH:-}"
if [ -z "$fence" ]; then
  echo "the fence of the deployment is not configured" >&2
  exit 1
fi
if [ ! -d "$fence" ]; then
  echo "the fence parent of the deployment is not there" >&2
  exit 1
fi
# The destination is private to the user that restores. It is created by the
# operator of the backup, because the directory of the bundles belongs to the
# operator of the server.
install -d -m 700 -o 65532 -g 65532 "$destination"
# The lock is taken as the user that owns the lifecycle. The file of the lock
# is therefore created by that user, with the mode the production code opens
# it with, and the copy is never made while a restore is running.
exec gosu 65532:65532 sh -c '
  set -eu
  umask 077
  fence="$1"
  destination="$2"
  # The file of the lock is created by the user that owns the lifecycle, with
  # the mode the production code opens it with. The umask above is what makes
  # it 0600.
  exec 9>"$fence/restore-fence.lock"
  # The lock of the lifecycle is taken without waiting, and the reason of a
  # refusal is kept. The conflict exit code of flock is 75 where the tool
  # supports it; the busybox flock of the alpine image has no such option
  # and is silent when the lock is held, so the two cases are told apart by
  # the message of the tool there. Every other failure keeps its own status
  # and its own message, and it is never reported as a running restore.
  lock_status=0
  lock_message=$(flock -E 75 -n 9 2>&1) || lock_status=$?
  case "$lock_message" in
    *"unrecognized option"*)
      lock_status=0
      lock_message=$(flock -n 9 2>&1) || lock_status=$?
      if [ "$lock_status" -eq 1 ] && [ -z "$lock_message" ]; then
        echo "a restore holds the lifecycle; the evidence is not copied" >&2
        exit 75
      fi
      ;;
  esac
  case "$lock_status" in
    0) ;;
    75)
      echo "a restore holds the lifecycle; the evidence is not copied" >&2
      exit 75
      ;;
    *)
      echo "the lock of the lifecycle could not be taken: $lock_message" >&2
      exit "$lock_status"
      ;;
  esac
  if [ ! -d "$fence/restore-requirements" ]; then
    echo "there is no evidence to copy: the lifecycle never bound a removal ledger"
    exit 0
  fi
  copied=0
  for record in "$fence"/restore-requirements/*.json; do
    [ -e "$record" ] || continue
    install -m 600 "$record" "$destination/$(basename "$record")"
    copied=$((copied + 1))
  done
  if [ "$copied" -eq 0 ]; then
    echo "there is no evidence to copy: the evidence directory of the lifecycle holds no record"
    exit 0
  fi
  printf "copied %d record(s) into %s\n" "$copied" "$destination"
' khabackup "$fence" "$destination"
