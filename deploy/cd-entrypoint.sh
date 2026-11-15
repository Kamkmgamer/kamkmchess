#!/bin/bash
# This is the forced command of the CI-only SSH key on the target host.
set -Eeuo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  deploy\ *) revision=${SSH_ORIGINAL_COMMAND#deploy } ;;
  *) echo 'Unsupported operation' >&2; exit 2 ;;
esac
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
umask 077
# The forced command sets KAMKM_BASE on a host whose deployment is not in /opt/kamkmchess.
export KAMKM_BASE=${KAMKM_BASE:-/opt/kamkmchess}
release=$(mktemp -d "$KAMKM_BASE/release.XXXXXXXX")
trap 'rm -rf "$release"' EXIT
ulimit -f 512000
cat > "$release/input.tar.gz"
python3 - "$release" <<'PY'
import pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
allowed = {'cd-target.sh', 'api.Dockerfile', *(f'bin/{name}' for name in ('kamkmchess-api', 'kamkmchess-migrate', 'khabackup', 'khasuspend')),
           *(f'rules-worker/{name}' for name in ('worker.mjs', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt'))}
with tarfile.open(root / 'input.tar.gz', 'r:gz') as archive:
    members = archive.getmembers()
    if len(members) != len(allowed) or {m.name for m in members} != allowed or any(not m.isfile() or m.size > 100_000_000 for m in members):
        raise SystemExit('Invalid release archive')
    for member in members:
        dest = root / member.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, dest.open('wb') as output:
            output.write(source.read())
PY
test -f "$release/cd-target.sh"
bash "$release/cd-target.sh" "$release"
