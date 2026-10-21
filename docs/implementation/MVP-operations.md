# MVP operations: deployment readiness, backups and restore

This document describes the offline readiness audit, encrypted backup format,
and the original local restore rehearsal. The active Vercel frontend and server
API/database deployment is documented in [the deployment runbook](../../deploy/README.md).
The hosted verification and restore run are recorded in
[the deployment evidence](../evidence/server-deployment.md).

Scope boundaries that the rest of the repository depends on:

* **Tooling is not evidence.** The presence of `backend/backup` does not pass
  `OPS-04`. Only a recorded rehearsal against a real database does.
* **No provisioning.** Nothing here creates an account, a bucket, a project or
  a scheduled job. Every destination is chosen by the owner.
* **No paid upgrade.** If free tiers cannot hold the contract, that constraint
  goes back to the owner before anything is bought.
* **Secrets are injected, never stored.** Every command takes the *name* of an
  environment variable. No command accepts a passphrase or a connection string
  as an argument, and no command prints one.

## Files

| Path | Purpose |
| --- | --- |
| `backend/backup/` | Container format, rotation planner, deletion-ledger recovery |
| `backend/backup/cmd/khabackup/` | The `khabackup` operator command |
| `scripts/release/kha-backup.ps1` | Windows operator wrapper for `khabackup` |
| `scripts/release/readiness-audit.mjs` | Offline deployment and boundary audit |
| `scripts/release/readiness-audit.test.mjs` | Offline tests for that audit |

Both entry points are free and local: Go's standard library, `pg_dump` and
`psql` from a local PostgreSQL client install, and Node for the audit.
No dependency was added for either.

The export is plain SQL, so `pg_restore` cannot read it: `pg_restore` loads
custom, directory and tar archives. The loader is `psql`, which gives the
single-transaction, fail-closed behaviour a restore needs.

## Readiness audit

```sh
node scripts/release/readiness-audit.mjs           # human report
node scripts/release/readiness-audit.mjs --json    # machine report
node scripts/release/readiness-audit.mjs --canary sk-EXAMPLECANARY0123456789
node --test scripts/release/readiness-audit.test.mjs
```

The audit reads local files only. It never makes a network request, never reads
a secret, and it exits non-zero when a blocker is present. It checks:

| Area | What is actually verified |
| --- | --- |
| Distribution | `dist/` exists; `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `DEPENDENCY_INVENTORY.json` are present; the notices retain MIT and CC BY-SA credits. The GPL project permits the reviewed chessops 0.15.1, Chessground 10.4.2 and Stockfish 19.0.1 licenses. Other copyleft dependencies, version or license changes, and NonCommercial entries require review or removal. |
| Bundle secrets | Every distributable text file is scanned for credential shapes (private keys, provider keys, GitHub/AWS/Slack/Google tokens, JWTs, PostgreSQL connection strings) and for server-only configuration names |
| Deployment | `vercel.json` CSP permits public HTTPS provider routes, forbids cleartext to non-loopback hosts, forbids `unsafe-inline`/`unsafe-eval` in `script-src`, keeps `worker-src 'self'`; `/v1/*` is routed to the Go function; every route in `backend/httpapi/api.go` is covered; Clerk callback routes exist |
| Server boundary | No Go file references a model provider key or provider host; every API handler resolves a verified owner from context |
| Identity | A Clerk browser SDK, when present, has CSP script/connect/frame origins. With no SDK installed, the audit reports an **external** gap rather than a pass |
| Account storage | `CLOUD_STORAGE_ENABLED` is documented and disabled, and `api/index.go` enforces the gate with a generic `no-store` 503 |
| Backup | Tooling and command are present, the runbook exists, and the local rehearsal record is checked in. Hosted rotation and a private destination are reported as **external** gaps until an operator runs them |
| Hygiene | `.env` ignored, lockfiles and the Node pin present, `engines.node` agrees with `.node-version` |

Severity is `blocker`, `warning`, `external` or `info`. `external` means only an
operator run against a real system can close it; the audit refuses to call those
passing.

The `--canary` mode exists so a clean scan is not mistaken for a scanner that
never matches: it plants a synthetic secret in memory and fails if the scanner
does not flag it.

Two boundaries the audit deliberately reports without fixing, because the
deployment configuration is owned elsewhere:

* the untracked `public/_headers` and `public/_redirects` files carry a second
  policy that a non-Vercel static host would honour. Vercel does not read
  `_redirects`, and a `/* -> /index.html 200` catch-all would capture `/v1/*` on
  a host that does.
* `vercel.json` is the authority for the Vercel host; see
  [KHA-44-hosting.md](KHA-44-hosting.md).

## Backups

`khabackup` seals one `pg_dump` plain-text logical export together with the
deletion ledger into a single authenticated container:

```
magic | header length | manifest JSON | AES-256-GCM ciphertext | SHA-256 trailer
```

* AES-256-GCM with a random 16-byte salt and 12-byte nonce.
* PBKDF2-HMAC-SHA256, 210,000 iterations. The iteration count is stored in the
  container, so raising it later never breaks older bundles.
* The manifest is the additional authenticated data, so a rewritten label,
  digest or restore lineage fails authentication.
* The plaintext carries a one-line header (`kamkmchess-logical-export 1 ...`)
  with the deletion ledger and SQL length, then the raw `pg_dump` output
  byte for byte.
* A bundle is written through a temporary file in the destination directory and
  renamed, with owner-only permissions on POSIX systems.
* One bundle is loaded whole in memory and is capped at 256 MiB of plaintext.
  That is a real limit, not a streaming design.

Rotation labels are `daily-YYYY-MM-DD` and `weekly-YYYY-Www` (ISO week, with
the real week count for that year checked). An unrecognised label is an error,
never a silent classification, so a manual export is not pruned by a daily rule.

### Create, verify and inspect

```sh
export KHA_BACKUP_PASSPHRASE='<at least 12 characters>'
export DATABASE_URL='postgres://user:password@host:5432/kamkmchess?sslmode=require'

go run ./backend/backup/cmd/khabackup create --out /backups/daily-2026-10-18.kha --class daily
go run ./backend/backup/cmd/khabackup create --out /backups/weekly-2026-W43.kha --class weekly
go run ./backend/backup/cmd/khabackup inspect --file /backups/daily-2026-10-18.kha   # no passphrase needed
go run ./backend/backup/cmd/khabackup verify --file /backups/daily-2026-10-18.kha
```

or, on Windows:

```powershell
./scripts/release/kha-backup.ps1 -Action create -Class daily -Out D:\backups\daily-2026-10-18.kha
```

`inspect` reads only the header, so an operator can see how a bundle was sealed
before a passphrase exists. `verify` authenticates and cross-checks the manifest
against the decrypted payload, including the deletion-ledger digest.

Client binaries come from the local PostgreSQL install and can be pointed
elsewhere with `--pg-dump` and `--psql`. Nothing is downloaded.

The passphrase is never accepted as an argument and never written to a file.
Store it in the owner's secret manager and inject it per run.

### Rotation

```sh
go run ./backend/backup/cmd/khabackup rotate --dir /backups
go run ./backend/backup/cmd/khabackup rotate --dir /backups --protect weekly-2026-W43 --apply
```

The planner keeps the seven newest daily and four newest weekly bundles. It
never deletes anything by itself: the first command prints a plan with a reason
per bundle, and only `--apply` deletes. A bundle is kept, with a visible reason,
when it is protected, when it has no recorded creation time, or when it is dated
after the reference time, because a future date usually means a clock problem.
Two bundles claiming one label is an error, not a coin flip. A file in the
directory that cannot be parsed is reported as unreadable and left alone.

Delete an applied bundle from a *separate* private destination if the operator's
retention requires it; this tool only rotates its own directory.

### Restore and deletion recovery

```sh
# 1. Rehearse: authenticate, and report the deletion recovery. Writes nothing.
go run ./backend/backup/cmd/khabackup plan --file /backups/weekly-2026-W42.kha

# 2. Execute, reapplying the newer daily ledger so nothing deleted since is resurrected.
#
# The two services mount **one** shared volume at the fence path. The path
# alone is not enough: a service that mounts another volume never sees the
# marker of the restore and keeps serving during the import.
#
# The service is stopped and drained before the import. The fence refuses new
# admissions, but it cannot take back a request that was already admitted, so a
# write that is still in flight would not be excluded by the restored copy.
# The restore refuses to run without a durable fence, and it has to run as the
# user the API observes the fence as, so the marker directory stays private to
# that user and the API can observe it.
#
# The secret file stays private: it is owned by the operator and has mode
# 0600, so the restore user cannot read it. The shell of the container reads
# it as root and hands the values to the restore through the environment; the
# restore itself never reads the file and never sees a secret as an argument.
# `gosu` drops to the restore user with that environment, so the fence stays
# private to the user the API observes it as.
#
# The fence path is the **parent directory** the compose files configure in
# both services with `ONLINE_RESTORE_FENCE_PATH`. The restore writes the owner
# of the fence into `<parent>/restore-fence/owner` and takes the sibling
# `<parent>/restore-fence.lock`. The API does not read that owner marker: its
# admission check only observes the marker directory `<parent>/restore-fence`,
# and it refuses to serve while that directory exists. A path below the parent
# would be a *different* fence: the restore would hold a fence the API never
# observes, and the API would keep serving during the import.
docker compose -f postgres.compose.yml -f api.compose.yml stop api
docker compose -f postgres.compose.yml -f api.compose.yml exec postgres sh -c '
  set -a; . /run/secrets/backup.env; set +a
  exec gosu 65532:65532 /opt/kamkmchess/khabackup restore --file /backups/weekly-2026-W42.kha \
    --newer-ledger /backups/daily-2026-10-18.kha \
    --fence /var/lib/kamkmchess/restore-fence \
    --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE --apply'
docker compose -f postgres.compose.yml -f api.compose.yml start api

# The API is stopped and drained before the restore, and it is started again
# after the removal ledger was replayed and the fence was closed.
#
# The fence refuses new admissions, but it cannot take back a request that
# was already admitted: an accepted write that is still in flight would not
# be excluded by the fence, and the restored copy would not carry it. The
# drain is therefore part of the procedure and not a convenience.
```

Beside the marker of the lifecycle the fence parent holds a second
directory, `<parent>/restore-requirements`, with the durable evidence of the
removal ledger that every restore owed. The import replaces the schema of the
target database, so a removal that only the live database carried would be
destroyed by the import itself; the evidence lives outside the database, is
written before the import starts, and is readable by its owner only
(`0700` for the directory, `0600` for the records).

That directory is **never cleaned by hand**, and neither is the gate of a
restore. The newest record is retained on purpose: it is the evidence that
the last restore closed the fence it owed, and the next restore discharges
the records whose removals it applied. A record is removed by the restore
that applied the removal, never by an operator.

The directory belongs in the **protected backup** of the deployment, next to
the encrypted bundles, and it is restored with them: a restore of a database
without the evidence of the pending restores cannot replay the removals they
owed. The file of one restore can also be restored on its own, and the
recovery then proves the ledger it owes against the digest the marker names
(`--evidence`).

The protected copy of the evidence is made while the service is stopped and
drained, so the record on the disk is the record of a restore that is not
running any more, and it is owned by the restore user:

```sh
# The API is stopped and drained first, so no restore is writing.
docker compose -f postgres.compose.yml -f api.compose.yml stop api

# The destination is private to the restore user and holds one record.
docker compose -f postgres.compose.yml -f api.compose.yml exec postgres sh -c '
  install -d -m 700 -o 65532 -g 65532 /var/lib/kamkmchess/restore-evidence &&
  install -m 600 -o 65532 -g 65532 \
    /var/lib/kamkmchess/restore-fence/restore-requirements/"$RESTORE_ID".evidence \
    /var/lib/kamkmchess/restore-evidence/"$RESTORE_ID".evidence'

# The protected copy is in the backup of the deployment, with the bundles,
# and it is restored to the same private path before a recovery that needs it.
```

A restore that was killed leaves the marker of the lifecycle behind and the
service stays closed, and the procedure is:

```sh
# The API is stopped and drained, so no write is admitted while the restore
# runs. A removal that was admitted before the fence was taken can still
# commit after the ledgers were read, and the import can lose it.
docker compose -f postgres.compose.yml -f api.compose.yml stop api

# The recovery of a restore that crashed. It does **not** replay anything:
# it verifies that the removal ledger the restore owed is applied and erased
# in the database, releases the gate and closes the fence. A database that
# lost the removals is not released: the recovery refuses and the gate stays
# closed, and only the take-over below imports and replays.
#
# The identifier of the restore is the one the marker of the lifecycle names.
# The command line of the restore cannot name it, so the operator reads it:
#
#   RESTORE_ID=$(docker compose -f postgres.compose.yml -f api.compose.yml \
#     exec -T postgres sh -c 'cat /var/lib/kamkmchess/restore-fence/restore-fence/owner' \
#     | sed -n 's/.*"restoreId":"\([^"]*\)".*/\1/p')
#   test -n "$RESTORE_ID"
docker compose -f postgres.compose.yml -f api.compose.yml exec postgres sh -c '
  set -a; . /run/secrets/backup.env; set +a
  exec gosu 65532:65532 /opt/kamkmchess/khabackup recover --file /backups/weekly-2026-W42.kha \
    --restore-id "$RESTORE_ID" \
    --fence /var/lib/kamkmchess/restore-fence \
    --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE'

# The recovery of a restore whose evidence directory was lost: the evidence
# of the restore is read from the protected copy of the file, and the recovery
# proves the ledger it owes against the digest the marker names.
docker compose -f postgres.compose.yml -f api.compose.yml exec postgres sh -c '
  set -a; . /run/secrets/backup.env; set +a
  exec gosu 65532:65532 /opt/kamkmchess/khabackup recover --file /backups/weekly-2026-W42.kha \
    --restore-id "$RESTORE_ID" \
    --evidence /var/lib/kamkmchess/restore-evidence/"$RESTORE_ID".evidence \
    --fence /var/lib/kamkmchess/restore-fence \
    --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE'

# The take-over of a restore that crashed before the evidence was written: it
# re-imports the bundle and replays the removal ledger again.
docker compose -f postgres.compose.yml -f api.compose.yml exec postgres sh -c '
  set -a; . /run/secrets/backup.env; set +a
  exec gosu 65532:65532 /opt/kamkmchess/khabackup restore --file /backups/weekly-2026-W42.kha \
    --fence /var/lib/kamkmchess/restore-fence --takeover \
    --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE --apply'

docker compose -f postgres.compose.yml -f api.compose.yml start api
```

The order inside a restore is fixed and tested:

1. read the container, verify the ciphertext trailer, authenticate, verify the
   plaintext digest and the deletion-ledger digest;
2. read the live ledger and merge it with the bundle ledger plus every
   `--newer-ledger` bundle, keeping the later deletion per game;
3. load the logical export with
   `psql -v ON_ERROR_STOP=1 --single-transaction -q -f -`, so the first error
   aborts and the whole load rolls back;
4. reapply the merged ledger in one transaction: write the tombstone first, then
   remove `archive_chunks`, `archive_events`, the stored operation payload and
   the checkpoint, and stamp `deleted_at` on the game row.

Live removal and backup expiry are different things. Deleting a game removes it
from the live database immediately; the encrypted copies still contain it until
the rotation expires them, and reapplying tombstones through the rotation is
what stops an older copy from bringing it back. There is no application age
purge: an account is retained until the owner deletes it.

If a restore fails before the import commits, the target database is
unchanged. A restore that fails **after** the import committed and before the
removal ledger was replayed leaves the restored database without the removals
that only the live database carried: the recovery refuses it, the gate stays
closed, and the take-over replays the owed ledger from the durable evidence.

### Recovery situations and what to do

| Situation | Action | Truthful limit |
| --- | --- | --- |
| Provider read-only or paused | The application keeps working locally; unsynced continuations stay in IndexedDB with a pending-sync warning | Only a real provider exercise proves pause and read-only behaviour |
| Daily export missed | Run `create` with today's daily label; a same-day re-run replaces the file atomically | Nothing enforces that the schedule ran; the audit cannot see a private destination |
| Bundle missing or corrupted | `verify` fails closed; restore the newest good bundle and pass the remaining bundles as `--newer-ledger` | A lost bundle is only recoverable if another copy in the rotation exists |
| An older copy is restored after a deletion | Pass the newer bundles as `--newer-ledger`; the merged ledger reapplies the deletion | Exercised locally against a disposable fixture, not against the managed service |
| Passphrase lost | Every bundle is unrecoverable | This is a real single point of failure; the owner must keep an escrow copy of the passphrase outside the backup destination |
| Older copy restored after a deletion | The merged ledger reapplies the deletion; the report counts `apply` and `refresh` actions | Verified only by the offline tests until a rehearsal runs |

## Database role split

`serverapp.Open` never migrates. Apply `backend/migrations/0001_storage.sql` with
a separate migration role (`go run ./cmd/migrate`) before the runtime connects,
and give the runtime role only what the storage API needs. `khabackup` needs read
access for the export plus the ability to write tombstones during recovery, so
run a rehearsal with a rehearsal role rather than the production superuser.

## Local rehearsal evidence

One rehearsal ran against the disposable local PostgreSQL fixture on
2026-10-18. It used two new databases, `mha_mvp_backup_fixture_src_*` and
`mha_mvp_backup_fixture_dst_*`, and no existing application data; both were
dropped afterwards and `kha41_test` was never written to. Canary rows used
only synthetic markers (`KHA-MVP-BACKUP-FIXTURE-*`).

| Step | Command | Observed |
| --- | --- | --- |
| 1 | `create --class weekly` | `weekly-2026-W42`, pg_dump 17.6, 2 games / 2 chunks / 2 events / 2 operations, 0 tombstones, plaintext SHA-256 `5165b872…c27b2`, 9 673 bytes |
| 2 | byte scan of the sealed file | none of `KHA-MVP-BACKUP-FIXTURE-KEEP`, `…-CHUNK-KEEP`, `CREATE TABLE` or `canary-game-keep` appear in the container; the header reads `KHA-BACKUP` |
| 3 | owner deletion of one canary game | tombstone written, chunks/events/operation payload/checkpoint removed, epoch advanced to 2 |
| 4 | `create --class daily` | `daily-2026-10-17`, 1 tombstone, plaintext SHA-256 `763bfe20…9556` |
| 5 | `verify` on both bundles | both authenticated; manifest digests matched the values recorded at seal time |
| 6 | `restore --apply` of the **older** weekly copy alone | both canary games present again, 2 chunks, 2 events, **0 tombstones** — the deletion is genuinely lost |
| 7 | `plan` with `--newer-ledger` on the daily copy | `apply 1, refresh 0, keep 0`, nothing written |
| 8 | `restore --apply` with `--newer-ledger` | ledger reapplied for 1 game; `canary-game-delete` tombstoned again with epoch 2, its chunk and event gone, `canary-game-keep` untouched |
| 9 | digest comparison, source vs restored | identical MD5 for the surviving game's checkpoint, chunk, event and operation payload |
| 10 | `rotate --dir` | both copies kept (`daily slot 1 of 7`, `weekly slot 1 of 4`), nothing deleted without `--apply` |

Bundle digests from that run, for reference:

```
daily-2026-10-17   c6e5d7a4dfa255469417ff5947ee18c957e3736077d2a42cdfa5e48bbabf7103  10 146 bytes
weekly-2026-W42    491ee283c19678770e4de1e11dbbe9061c30b715fe9c85c9a495cba50a799189  10 223 bytes
```

What this rehearsal does **not** prove:

* Step 3 performed the owner deletion with SQL that mirrors
  `backend/storage`'s delete transaction. It did not drive the Clerk-authenticated
  HTTP API, because that path needs a verified session and a fully valid
  `GameCheckpointV1` fixture.
* The passphrase was a rehearsal string. Nothing here demonstrates operator
  escrow, a lost-passphrase recovery or a private destination.
* The rotation ran over two copies with nothing to prune. Pruning itself is
  covered by the offline tests, not by this rehearsal.
* This is a local fixture, not a managed free-tier database. No quota, inactivity
  pause, read-only mode or connection limit was exercised.

## Test evidence

```sh
go test ./backend/backup/...                     # container, rotation, recovery, CLI
go vet ./backend/backup/...
node --test scripts/release/readiness-audit.test.mjs
pnpm exec eslint scripts/release --max-warnings 0
```

The Go tests are offline and deterministic: they use a fake dumper, a fake
ledger and a fake restorer, so no database, network or credential is needed.
They cover wrong-passphrase rejection, ciphertext and manifest tampering,
owner-only bundle permissions, the size bound, canonical ledger encoding, the
seven-daily/four-weekly rotation and its refusals, the apply/refresh/keep
deletion recovery, "no database write before authentication", and that a failed
load does not run recovery.

## What is still open

These are external gaps. The tooling above does not close any of them.

* **Hosted recovery now has a rehearsal.** On 2026-10-18 an encrypted export was
  restored into an isolated database on the real server. Restoring the older
  weekly export with the newer daily deletion ledger reapplied two synthetic
  game deletions. Daily server backups and certificate checks are scheduled.
* **Recurring offsite copies remain open.** Encrypted bundles stay in a private
  server directory, with an initial recovery copy outside the server. The daily
  cron does not synchronize that separate recovery copy.
* **No free-tier capacity has been measured.** Archive growth, quotas, inactivity
  pauses and read-only modes are unrecorded. If free operation cannot hold the
  contract, that constraint returns to the owner before a purchase.
* **Google OAuth remains unconfigured.** The deployed Clerk production instance
  supports email sign-in. Google requires its own production OAuth client.
* **Native and assistive-technology acceptance is unrelated to this tooling.**
  The readiness audit reads files; it certifies no browser, screen reader, live
  provider or deployed route.
