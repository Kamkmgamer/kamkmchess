# KHA-83 evidence — host verification for the online service

Tested tree: the **root `33a23c1`** (the privacy candidate of the
removal ledger and the durable evidence) with the operations candidate of
this file applied. Every number and every step id below is the output of
the tools on that tree, and the commit that carries this file names the
exact tree it was measured on. The measurements are **local**, against the
fixture container of this machine; the host is not verified, and the local
rehearsal of 2026-10-18 that
[`MVP-operations.md`](MVP-operations.md) records is a separate, older
rehearsal that is not part of this candidate.

The fence helper of this tree binds and closes with the removal ledger of
the privacy candidate, and it builds and runs on it. The container proofs
are reproduced by the workflow `container-proofs` of
`.github/workflows/online-ops.yml`, which starts a `postgres:17.6`
fixture and runs the three container proofs against it; the helpers reach
the published port of the fixture through `host.docker.internal`, which a
Linux engine resolves only with the mapping the proofs pass.

## What is prepared

- **Private rules runtime.** `tools/onlinefixture` and the pinned Node 24
  bundle give the Go authority a private rules process with no public
  endpoint, no provider access and no database access. The bundle build is
  pinned to chessops 0.15.1 and the rules policy `online-rules/1`; the
  dependency inventory and the notices are written next to the artifact by
  `scripts/build-rules-worker.mjs`.
- **Least-privilege runtime grants.** `deploy/runtime-grants.policy.json`
  lists the privileges of every migrated table explicitly. `pnpm run
  grants:check` compares the policy with the migrations and with the writer's
  own statements; `pnpm run grants:probe` applies the grants to a real
  PostgreSQL and executes statements as the role.
- **Backup coverage and the removal ledger.** `pnpm run online:backup` audits
  the dump and the restore path and prints the restore hooks.
- **Local load harness.** `pnpm run online:load` produces a synthetic local
  load report with the request rate, the latency percentiles, the database
  connections and the slow-reader behaviour.

## Measured locally (not a host measurement)

The grant probe ran against the local PostgreSQL 17 fixture
(`127.0.0.1:55467`, database `kamkmchess_online_test`) on the schema of
the tree at `d88eafc` (migrations up to
`0019_privacy_auxiliary_redaction`):

```
221 probes, 0 failures
```

The probe applies the reviewed policy to a throwaway role and schema, then
executes real statements as that role: a read, an insert, an update and a
delete on every table the policy covers, and the refusals on every table it
does not. It proves that the role can do exactly what the policy says and
nothing else, that PUBLIC holds nothing on the application tables, that only
the deployment role holds a privilege on them, and that the effective
privileges match the policy table by table.

It also proves the function boundary. PostgreSQL grants EXECUTE on a new
function to PUBLIC, and a function that is not a trigger function can be
called directly, outside the write path that owns it. The probe shows that
PUBLIC cannot execute a plain function directly and that every plain function
is covered by the policy. The trigger functions need no grant: PostgreSQL
checks their EXECUTE privilege when the trigger is created and refuses a
direct call.

The policy lists 45 tables. Some of the privileges the assembled schema
needs:

| Table | Verbs the runtime role holds | Why |
| --- | --- | --- |
| `online_friend_invitations` | SELECT, INSERT, UPDATE, DELETE | the auxiliary sanitation of a removed subject deletes the invitation |
| `online_invitation_acceptances` | SELECT, INSERT, UPDATE, DELETE | the same sanitation deletes the acceptance |
| `online_queue_entries` | SELECT, INSERT, UPDATE, DELETE | the same sanitation deletes the entry |
| `online_queue_allocations` | SELECT, INSERT, UPDATE | the sanitation redacts the allocation in place |
| `online_service_epochs` | SELECT, INSERT, UPDATE | the service gate records the recovered epoch |

The deployment image is built and inspected locally by
`node deploy/verify-runtime-image.mjs`:

```
9 checks, 0 failures
```

The image carries the pinned Node 24.22.0 runtime, the private rules bundle
at its configured entry path, and a real protocol request answered by the
worker inside the image. The container runs as uid 65532 and carries no
credential file. Nothing is pushed and nothing is deployed.

The static audits are clean against the assembled tree:

| Audit | Result |
| --- | --- |
| `node deploy/runtime-grants.mjs` | clear (7 findings), 45 tables in the policy, no blocker; the 40 tables the migrations grant to the unused role are reported once, and the policy role is compared table by table |
| `node scripts/online/service-wiring.mjs` | the feature route is served, both switches are read with a closed default, the restore fence is loaded and shared |
| `node scripts/online/backup-coverage.mjs` | the dump covers the database, the game and the online removal ledgers are reapplied, the restore gate is consulted before serving |

The local load report is `docs/evidence/online/KHA-83-local-load.json` when a
load run has been made. It is a loopback measurement with synthetic accounts.
It is **not** a capacity claim.

The recorded report measures **the rejection path only**: every one of its
196 responses was answered `401`, including the 158 requests that carried a
freshly minted fixture bearer token, so no request of that run was served
and no game was read. Its latency percentiles describe how long the
service took to refuse a request, not how it behaves under load. The
harness now refuses to write a report in which nothing was served, and the
measurement of a serving path is still **not run** and not claimed.

## The restore, the compose files and the evidence

- The restore procedure **stops and drains the API** before the import and
  starts it again afterwards. The fence refuses new admissions, but it cannot
  take back a request that was already admitted: an accepted write that is
  still in flight would not be excluded by the restored copy. The drain is
  part of the procedure, and the evidence does not claim that new admissions
  are refused to drain work in flight.
- The database service and the API service are started **together**: the API
  file refers to the database service, so
  `docker compose -f postgres.compose.yml -f api.compose.yml` is the only
  usable invocation. The API file alone fails with an undefined service.
- The shell argument of the database entrypoint is written in the escaped form
  (`"$$@"`). The reviewer of round four verified that the plain and the
  escaped form forward the arguments identically, so the change is a
  portability and clarity change, **not** a fix for a lost argument. The
  proof reads the settings from the running server either way.
- The native restore stages are prepared and green: the database tools of the
  server, the backup command built from the checked-in source, a database of
  the run with the checked-in migrations, an encrypted bundle created and
  verified with the real tool, and the bundle copied to the host. The restore,
  the wrong clear, the overlap and the take-over **are** run now, by
  `node scripts/online/restore-proof.mjs`, against the fence lifecycle of the
  privacy service: the restore is refused without a fence, a second restore
  is refused while the fence is held, a close with a digest that does not
  belong to the fence is refused, the death of the holder leaves the marker,
  the take-over finishes and closes the fence, and the service serves again
  afterwards. The **crash of the restore during its import** is still not
  run: that case belongs to the privacy work, and the proof says so in its
  own limits.
- The runbook, the deployment note and the rendered compose configuration name
  the **same** fence: the parent directory `/var/lib/kamkmchess/restore-fence`.
  A path below the parent is a different fence, and a restore that held it
  would leave the service serving during the import. The proof compares the
  three names and measures that the service observes the fence the runbook
  opens. The observation is the *existence* of the marker directory
  `<parent>/restore-fence`: the admission check of the API does not read the
  owner marker, and the service refuses to serve while that directory
  exists.
- The private secret of the restore stays private: the file is owned by the
  operator and has mode `0600`, so the restore user cannot read it. The
  documented command reads it as root and hands the values to the restore
  through the environment (`gosu 65532:65532`), so the restore user receives
  them without ever reading the file. `node deploy/verify-compose-config.mjs`
  measures that inside the real service container, with a negative control:
  the restore user is refused the file, the documented reading side hands the
  values over, and the file is still `0600` and owned by root afterwards.
   The compose proof reports 11 steps, all of them passed at `d88eafc`.
- The superseded `scripts/online/prepare-restore-fixture.mjs` is **removed**.
   It wrote the restore command that cannot run (it sourced the private file
   as the restore user) and left a bundle and a stages file on the host; the
   native proof supersedes it. A test fails if any file of the repository
   ships that command again.

## The interruption of a native restore

`node scripts/online/restore-interruption-proof.mjs` kills the **real**
restore of the real binary at a real barrier in front of the real psql, and
it measures the two interruptions that decide whether a removed subject can
come back.

The kill during the import transaction is **measured green**: the barrier
holds the transaction open with a marker statement, the restore is killed
while the transaction is active, the transaction is rolled back, the live
removals are still in the database, the record of the removed match is not
revoked, and the recovery of the crashed restore closes the fence again.

The kill after the commit and before the replay is **measured green**:
the real psql committed the import, the restore was killed before the
removal ledger was replayed, the import replaced the table of the live only
row of the target, and the removals that only the live database carried are
gone from the database. The recovery refuses that database and keeps the
service closed, the take-over replays the exact ledger the restore owed
from the durable evidence, and the service admits again only after the
replay.

The earlier report of this evidence named a unique violation on
`online_removal_requests_pkey` as a defect of the product. It was not: the
seed of the proof named the request of the match bound removal like the
identifier the subject replay derives, and the two collided on the primary
key of the request. The seed uses independent identifiers now, and the
collision is kept as a separate case for the correction the privacy work is
making.

The barrier of the proof is a program of its own for every case, with the
mode written into it, because the environment of the loader is an explicit
allowlist of the production code and never carries a switch of the proof.
The proof does not change that allowlist. The kill during the transaction is
proven at the injected barrier: the backend of the barrier waits inside the
import transaction on the marker statement, and the owner of the lifecycle is
read while the restore is alive and is the same after the crash.

The durable evidence of the owed ledger is written next to the marker of the
lifecycle, and the access proof measures it: the directory is `0700` and
the record is `0600`, both owned by the user of the service. The
interruption proof measures it as well, while the restore is dead and the
removals it owed are still missing from the database.

## Open blockers

1. **The fence access is fixed in the deployment, and the proof is green.**
   `node deploy/verify-fence-access.mjs` runs the real fence code of the
   privacy service in throwaway containers against a volume this run created:

   The tool reports 13 steps, and every one of them passed at `d88eafc`:

   | Step id | Result |
   | --- | --- |
   | `the-target-of-the-proof-is-accepted` | passed |
   | `the-target-addresses-the-published-port` | passed |
   | `the-runbook-and-the-configuration-name-the-same-fence` | passed |
   | `the-services-mount-the-same-fence-volume` | passed |
   | `the-proof-detects-a-diverging-fence-volume` | passed |
   | `the-service-observes-the-fence-the-runbook-opens` | passed |
   | `the-shared-fence-directory-is-prepared` | passed |
   | `the-database-user-cannot-write-the-fence` | passed |
   | `the-schema-of-the-run-is-owned` | passed |
   | `the-service-takes-the-fence` | passed |
   | `the-service-refuses-while-the-fence-is-held` | passed (503) |
   | `the-service-serves-again-after-the-fence-is-closed` | passed (200) |
   | `the-schema-of-the-run-is-dropped` | passed |

   The remedy is a deployment choice, not a mode decision: the database
   service prepares the shared directory for the user the API observes it as,
   and the restore runs as that user. The marker keeps its private mode. The
   API therefore observes the open fence and refuses traffic during the
   restore, and observes the closed fence and resumes afterwards.

   **What this proof is not.** It proves the shared ownership, the permission
   boundary, the serving gate, the agreement between the runbook, the note and
   the rendered configuration, and the agreement of the two services on the
   **volume** (a configuration that mounts another volume is rendered and has
   to be refused). The encrypted restore itself is proved by
   `node scripts/online/restore-proof.mjs`, which runs the real
   `khabackup` against the fence lifecycle of the privacy service and reports
   18 steps, all of them passed at `d88eafc`. The one case neither proof runs
   is a **crash of the restore during its import**: that belongs to the privacy
   work, and both proofs say so in their limits.
2. **The host has not been verified.** Apache flushing, finite stream
   delivery, the delivered CSP and CORS, the TLS chain, the private worker
   reachability and the capacity need the real host and an authorized staging
   session. No staging authorization is recorded, so these stay **not run**
   and the release gates report the host requirement as external.
3. **The migrations grant privileges of their own.** The online migrations
   create `kamkm_online_api` and `kamkm_online_rules` and grant the first one
   `SELECT, INSERT, UPDATE, DELETE` on the online tables, including the
   append-only ones. The audit now sees all 40 of those tables. The
   deployment connects as `kamkmchess_runtime`, the role the reviewed policy
   describes, and provisioning revokes the privileges of the unused roles, so
   no unused role keeps a grant. The grants themselves still exist in the
   migrations.
4. **The removal marker is a consistency check, not an authorisation
   boundary.** The runtime role can write the removal request the redaction
   guard demands, so the marker does not stop an actor that already controls
   the API's SQL. The ownership proof in the application layer is the actual
   boundary. Nothing in the deployment changes that, and the grant policy
   does not grant `DELETE` on the removal requests.
5. **A new migration needs a policy entry.** The audit names the missing
   table and `--propose` prints the entry with the privileges the writer uses.
   A privacy cleanup that deletes rows needs the matching `DELETE` in the
   policy, and a plain function needs an entry in the function section so the
   deployment revokes its EXECUTE from PUBLIC.

## Not run, and why

- Apache flushing, finite stream delivery, the delivered CSP and CORS, the TLS
  chain and the private worker reachability need the real host and an
  authorized staging session. No staging authorization is recorded, so these
  stay **not run**.
- The sustainable clients and games, the pool use, the CPU, the memory, the
  storage and the connection counts of the host need the host. The local
  numbers are not transferable.
- The backup rotation, the private offsite copy and the restore rehearsal on
  the host are not executed here.

**No deployment and no feature enablement happened.** The host record
`docs/evidence/online/KHA-83-host.json` does not exist yet, so the release
gates report the host requirement as external.
