# KHA-80 evidence — local integration under competing clients, workers and failures

**Current state: not green.** The latest suite run leaves one mapped scenario
recorded as failed and the Go integration package shows timing-sensitive
failures under load. The earlier all-green checkpoint is kept below as
history, not as the current result.

Tested commit: `f1680c6` (the operations slice on top of the integrated
service `4a0e46c`). The application code under test is the integrated tree;
every command below runs against a real PostgreSQL 17 database, the real Go
service and the pinned private rules worker bundle
(`build/rules-worker/worker.mjs`, chessops 0.15.1, rules policy
`online-rules/1`).

## Current result

| Item | Result |
| --- | --- |
| Evidence ledger | **0 passed, 16 failed, 46 not run** |
| Why | every recorded scenario cites a commit that is not an ancestor of the tested tree, or its case failed in the newest run, so the ledger refuses to count it as a pass |
| Go integration package | fails under load; a different timing-sensitive test failed in each of three runs |
| Browser suite (strict, real Chromium, real service) | 4 passed, 1 skipped in isolation; the suite run that produced the newest report failed |
| Grant probe against a real PostgreSQL | the privilege probes pass; the behavioural scenarios pass, including the seeded control timeline write |
| Deployment image verification | 9 checks, 0 failures |

The ledger now enforces two rules that make a stale pass impossible:

- a record whose commit is **not an ancestor of the tested tree** is not a
  pass. The earlier records cited the pre-integration worker commits
  (`9c6bc79`, `e283d27`), which describe a different code base than the
  integrated tree, so they are failures now;
- a record whose scenario **failed in the newest run** is not a pass. The
  browser records are rewritten for every outcome, so a failed browser run
  replaces the earlier passing record of the same scenario.

A fresh run on the assembled root is therefore required before any scenario
can be recorded as passing again. The parent runs that final suite.

The failed record that is left is `ARC-08`: its mapped test
`TestPostgresOnlinePendingRevocationRejectsTheWaitingDuplicatePreflight` failed
in the latest suite run. The record is kept as a failure on purpose. The test
passes in isolation, so the package is flaky under load rather than
deterministically broken, but a flaky package is not a green package and the
evidence says so.

### The failures observed in the Go package

| Test | Outcome |
| --- | --- |
| `TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut` | failed in one suite run, passes in isolation (15s) |
| `TestPostgresOnlinePendingRevocationRejectsTheWaitingDuplicatePreflight` | failed in one suite run, passes in isolation |
| `TestPostgresOnlineMixedControlAttributesEveryMoveAndTheTerminalAction` | **fails deterministically**: `execute op-move-2: online: participant does not control seat`. The test hands the black seat to an agent and then submits the next move as the human account; the service refuses it. Either the control rule or the test expectation is wrong. It belongs to the application workers. |

Reproduction of the deterministic one:

```sh
KHA41_TEST_DATABASE_URL="$ONLINE_FIXTURE_DATABASE_URL" KHA41_REQUIRE_POSTGRES=1 \
  KHA66_WORKER_ENTRY="$PWD/build/rules-worker/worker.mjs" \
  go test ./backend/integration -count=1 -run TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction
```

## Reproduction

```sh
# Local PostgreSQL fixture
docker start kamkmchess-kha67-local            # 127.0.0.1:55467, db kamkmchess_online_test
export ONLINE_FIXTURE_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'

pnpm install --frozen-lockfile
pnpm run online:integration                    # Go integration suite + evidence records
pnpm run online:fixture                        # the real composition on loopback
pnpm exec playwright test tests/e2e/online-clients.spec.ts
```

`pnpm run online:integration` builds the rules worker bundle, runs
`go test ./backend/integration -count=1 -json` against the database, maps the
results onto the approved acceptance scenarios and writes
`docs/evidence/online/KHA-80-integration.json` plus one evidence record per
covered scenario.

## Earlier checkpoint (history, not the current result)

At commit `9c6bc79` (on top of the integrated service `3d63aab`) the run
executed 163 Go integration tests and every test passed. The scenario table
below is that checkpoint. It is kept because it shows what the suite covers,
not because it is the latest result.

| Scenario | Mapped tests | Result |
| --- | --- | --- |
| MAT-03 | in-flight retry receipt, non-member command | passed |
| MAT-04 | command past the main deadline, command past the reply deadline | passed |
| MAT-11 | draw consent bound to the offer, takeback consent bound to the offer | passed |
| ARC-02 | accepted setup retry with an unavailable worker, HTTP cannot invoke the trusted reconciliation | passed |
| ARC-03 | expired credential after the lock wait, revocation during rules evaluation | passed |
| ARC-04 | in-flight retry, acceptance retry, expired credential cannot replay | passed |
| ARC-05 | non-member read or command, session revocation before expiry, revoked guest credential | passed |
| ARC-06 | guest credential authorizes its seat and reconnects, one live credential per seat | passed |
| ARC-08 | one live credential per seat, pending revocation rejects the duplicate preflight | passed |
| ARC-09 | accepted setup retry survives an unavailable worker | passed |
| ARC-10 | bounded due deadline scan, idempotent concurrent sweeps | passed |
| ARC-11 | reconciliation holds the clock while the rules service is unavailable, server lifecycle settles a due match | passed |
| HIS-10 | the stored state never carries the credential secret, the public replay is public and the live state is not | passed |

Failure injection exercised by those tests: an unavailable rules worker, a
worker that is revoked while it evaluates, a command that waits past the main
and the reply deadline, a lock wait that outlives the credential, a duplicate
and a replayed operation, a pending revocation that races a waiting read, a
concurrent deadline sweep and a service restart.

The report is `docs/evidence/online/KHA-80-integration.json`; the evidence
records are in `docs/evidence/online/records/`.

### A flaky test to look at

One of three full-package runs failed on
`TestPostgresOnlineUpdatesStreamDeliversTheCanonicalSnapshotAndTheNextVersion`
while the whole package ran. The same test passed three times in isolation and
in two later full-package runs, so the failure is timing sensitive under load
rather than a deterministic defect. It is reported here because a flaky stream
test weakens the evidence of every run that includes it. The scenarios that
map to it are not marked as passing by the suite until it is stable.

## Real browser clients

`tests/e2e/online-clients.spec.ts` drives two Chromium contexts against the
fixture: an account client and a guest client. It asserts the exact published
DTO field names of the feature route, the invitation, the acceptance answer,
the participant live view and an accepted move. A renamed or missing field
fails the run.

The strict run against the integrated service (`ONLINE_FIXTURE_STRICT=1`,
`ONLINE_FIXTURE_DESCRIPTOR=<descriptor>`):

| Case | Result |
| --- | --- |
| the feature route reports exactly the two switches | passed |
| a guest accepts a friend invitation and both clients observe the same accepted move | passed |
| a consumed invitation cannot be accepted twice and a guest without a credential is refused | passed |
| the rendered workspace reflects the real service state | passed |
| the production interface renders the invitation link | skipped: the browser route for an invitation link is not published yet |

The friend case proves the whole flow against the real service: the account
client creates an invitation, the link preview never carries the owner token,
the guest client accepts it and receives a seat-scoped credential, the account
client submits `e2e4`, the guest client observes the accepted move with the
same version, the stale command is refused, the guest answers the opening
move with `e7e5` and both clients see the second move.

The rendered case proves that the interface follows the service it is bound
to: the rendered action matches the answer of the service the application
actually reads, and it never opens a surface that service keeps closed. A
build without the account configuration never asks the service, and the case
then proves that the closed surface stays closed.

**Still missing:** the signed-in account path. There is no account build in
this environment (no identity provider key), so the queue surface cannot be
driven by a real signed-in account, and the invitation link route of the
browser is not published yet. The workspace owns both.

## One failing test in the integrated tree

The Go integration package fails on
`TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction`:

```
--- FAIL: TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction (2.38s)
    online_history_test.go:371: execute op-move-2: online: participant does not control seat
```

The test hands the black seat to an agent and then submits the next move as
the human account. The service refuses it because the seat is now controlled
by the agent. Either the control rule or the test expectation is wrong; both
belong to the application workers. It is not marked as an evidence failure of
a mapped scenario, because no mapped scenario covers it, and it is recorded
here so the assembled branch does not look green while a package test fails.

Reproduction:

```sh
KHA41_TEST_DATABASE_URL="$ONLINE_FIXTURE_DATABASE_URL" KHA41_REQUIRE_POSTGRES=1 \
  KHA66_WORKER_ENTRY="$PWD/build/rules-worker/worker.mjs" \
  go test ./backend/integration -count=1 -run TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction
```

## Not exercised here

- The competing matchmaker, the late timer and the fallback paths of the
  public queue: the queue writer is not in this commit.
- Native assistive technology, live host measurements and the rollout
  outcomes. They stay separate from the local results.
