# KHA-85 evidence — the public queue release

Evidence pins of the recorded material: the local backend race at
`ab0dba56eaa837d1db3aaea0df2ed3d2773d65d1`, the fixture browser run at
`1e08868d71e3105288ba59af24f55ea3df310593`, the assembled report at
`7caaef4`. The gate output below was produced from the working tree of
`feature/online-play-swarm`, which is not a commit. The earlier
`Tested commit: 0b24151` line is withdrawn: `0b24151` carried the approved
contract and its acceptance trace into the tree, the gate tool did not exist
at that commit, and no recorded evidence is pinned to it, so it never
described the tested tree.

**Status: blocked. The public queue is not enabled and must not be enabled
yet.**

## The gate

`node scripts/online/feature-gates.mjs evaluate --gate queue` reports every
requirement of the queue gate. It is stricter than the friend gate:

- the recorded release decision, the recorded cohort, the measured runtime
  cohort, the enforced cohort, the host verification record, the backup
  coverage check and the runtime grant check of the friend gate;
- an **accepted friend cohort run**, recorded in
  `docs/evidence/online/KHA-84-friend-run.json`. The record has to name the
  accepted outcome, the acceptor, the date, the tested commit and the cohort
  of the run, and the cohort of the run has to be the recorded friend cohort
  of `docs/evidence/online/release-decisions/friend-cohort.json`, compared by
  its algorithm, its commitment and its count. A file at the recorded path is
  not an accepted run; the schema of the record is in
  [online-operations.md](online-operations.md);
- passing evidence for `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11` and `QUE-12`;
- a host capacity record, `ARC-14`.

The queue gate does not re-require the local evidence of the friend
scenarios. What it takes from the friend side is the accepted friend cohort
run, and that run is the only friend-side evidence the queue waits for.

The queue adds **no owner game cap, entry cap or agent cap**. The gate
requires an accepted friend cohort as a process requirement; it never
introduces an arbitrary limit.

## Current state

| Requirement | State | Detail |
| --- | --- | --- |
| release-decision | unmet | No owner release decision is recorded for the queue gate. |
| cohort | unmet | The protected operator input is missing, so no cohort is recorded. |
| runtime-cohort | unmet | No cohort is recorded, so there is no runtime cohort to measure. An unset cohort setting admits every signed-in account. |
| host-verification | external | No host verification record exists. Apache flushing, TLS, CORS, private worker reachability and capacity are measured on the host, not locally. |
| backup-coverage | met | The backup covers the whole database and the restore reapplies the removal ledger. |
| runtime-grants | met | The runtime policy grants the 45 migrated tables exactly what the writer uses. |
| local-evidence | unmet | `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11` and `QUE-12` have no passing evidence; the ledger carries no record for any of them. |
| host-evidence | external | `ARC-14` is `not_run`; the host capacity record does not exist. |
| cohort-enforcement | met | The enforcement tests of the tree passed and the proof of the composition proved that the cohort of `ONLINE_QUEUE_COHORT` and `ONLINE_FRIEND_COHORT` reaches the request path of the surface. |
| friend-cohort-run | unmet | No accepted friend cohort run is recorded. |

The reversible rollout packet is printed by
`node scripts/online/feature-gates.mjs packet --gate queue`. It names the
configuration change, the monitoring, the rollback and the blast radius, and
it applies nothing. It reports `deployable: false` and it names the
requirements that block it. Rollback is reversible: closing the switch stops
new creations and leaves running matches, their results and the issued guest
credentials untouched.

## Implemented locally

The queue writer, the matching, the cutoff equality, the atomic allocation,
the Stockfish fallback and the fixed opponent **are implemented in this
branch**. They are local behavior with local tests, and they are not release
evidence:

- `backend/queue/queue.go` — the entry lifecycle: one entry per explicit
  request, the readiness of the seat, the cancellation, the keep-searching
  route that removes the automatic cutoff, the heartbeat, and the bucket lock
  that every queue write takes before it writes the row.
- `backend/queue/allocate.go` — the decision under the bucket lock: the scan
  for the oldest compatible ready entry, the re-scan at the decision time,
  the allocation row that consumes an entry exactly once, the pending
  fallback record and the scoped engine seat credential.
- `backend/queue/worker.go` — the sweep that resolves the due cutoffs and
  expires the waiting entries whose owner stopped responding.
- `src/online/queue.ts`, `src/online/engine-seat.ts` and
  `src/online/engine-preparation.ts` — the browser side: the state of the
  entry, the keep-searching and fallback routes, and the preparation of the
  browser Stockfish 19 Lite.

The rules those parts implement are stated in
[docs/online/queue-contract.md](../online/queue-contract.md): only accounts
enter the queue, two entries match when they have the same starting time and
increment, different owners and at least one agent seat, the oldest eligible
ready entry answers, a candidate that becomes ready exactly at the cutoff
wins over the engine, one entry produces exactly one game and one fixed
opponent, and there is no owner concurrency cap.

## Not yet run

The recorded release evidence of the queue is absent. `QUE-01`, `QUE-03`,
`QUE-09`, `QUE-11` and `QUE-12` are `not_run` — the ledger carries no record
for them — and `ARC-14` is `not_run` as well, so the host capacity record
the gate asks for does not exist. The queue gate is therefore blocked on the
local evidence and on the host evidence of the queue themselves, apart from
the outstanding release decision, cohort, runtime cohort and friend cohort
run.

`REL-02` stays `not_run`: recording the tooling and the gate does not supply
the public-queue release decision. `UX-01` and `REL-01` are the two planning
approvals of the unchanged contract, and they are not release approvals.

No platform-funded AI usage, no deployment and no queue enablement happened.
A local simulation is not a deployment, and no deployment completion is
inferred from one.

## What remains unverified

- The recorded release evidence of `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11`,
  `QUE-12` and `ARC-14`.
- Deployed host capacity, delivered TLS, CSP and Apache streaming behavior.
- A released cohort: the enrollment of the accounts, and the cohort of the
  running server measured on the host.
- The accepted friend cohort run and the owner release approval of the queue
  gate.

The stored load report `docs/evidence/online/KHA-83-local-load.json` measured
the rejection path: all 196 requests answered `401`. It is not
serving-capacity evidence.
