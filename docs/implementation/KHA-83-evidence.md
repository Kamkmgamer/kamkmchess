# KHA-83 evidence — host verification for the online service

Tested commit: `0b24151`.

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
(`127.0.0.1:55467`, database `kamkmchess_online_test`):

```
209 probes, 0 failures
```

The probe applies the reviewed policy to a throwaway role and schema, then
executes real statements as that role: a read, an insert, an update and a
delete on every table the policy covers, and the refusals on every table it
does not. It proves that the role can do exactly what the policy says and
nothing else, that PUBLIC holds nothing on the application tables, that only
the deployment role holds a privilege on them, and that the effective
privileges match the policy table by table. The policy covers the 45 migrated
tables.

The deployment image is built and inspected locally by
`node deploy/verify-runtime-image.mjs`:

```
9 checks, 0 failures
```

The image carries the pinned Node 24.22.0 runtime, the private rules bundle
at its configured entry path, and a real protocol request answered by the
worker inside the image. The container runs as uid 65532 and carries no
credential file. Nothing is pushed and nothing is deployed.

The static audits are clean against the integrated tree:

| Audit | Result |
| --- | --- |
| `node deploy/runtime-grants.mjs` | clear, 45 tables, no blocker |
| `node scripts/online/service-wiring.mjs` | the feature route is served, both switches are read with a closed default, the restore fence is loaded and shared |
| `node scripts/online/backup-coverage.mjs` | the dump covers the database, the game and the online removal ledgers are reapplied, the restore gate is consulted before serving |

The local load report is `docs/evidence/online/KHA-83-local-load.json` when a
load run has been made. It is a loopback measurement with synthetic accounts.
It is **not** a capacity claim.

## Open blockers

1. **The host has not been verified.** Apache flushing, finite stream
   delivery, the delivered CSP and CORS, the TLS chain, the private worker
   reachability and the capacity need the real host and an authorized staging
   session. No staging authorization is recorded, so these stay **not run**
   and the release gates report the host requirement as external.
2. **The migrations grant privileges of their own.** The online migrations
   create `kamkm_online_api` and `kamkm_online_rules` and grant the first one
   `SELECT, INSERT, UPDATE, DELETE` on the online tables, including the
   append-only ones. The deployment connects as `kamkmchess_runtime`, the role
   the reviewed policy describes, and provisioning revokes the privileges of
   the unused roles, so no unused role keeps a grant. The grants themselves
   still exist in the migrations and are reported by the audit.
3. **A new migration needs a policy entry.** When the service gate migration
   lands, the audit names the missing table and `--propose` prints the entry
   with the privileges the writer uses. A privacy cleanup that deletes rows
   will need the matching `DELETE` in the policy.

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
