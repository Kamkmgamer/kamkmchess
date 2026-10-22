# KHA-80 evidence — local integration under competing clients, workers and failures

**Current state: partial evidence, not a green acceptance.** The approved
contract `docs/spec/online-play-acceptance.json` is unchanged. The generated
ledger `docs/evidence/online/ledger.json` reports **0 passed, 0 failed,
0 blocked, 16 partial, 46 not run**: no approved scenario is closed. The
sixteen partial records name the exact tests that passed for a part of a
broader scenario. Partial evidence is not acceptance and nothing in this file
claims that it is.

Tested source pins. Both are ancestors of the current HEAD
`7caaef449bc62a96f32f2cb84f9b783e34735be7` (checked with
`git merge-base --is-ancestor`):

| Pin | Sources under test | Exact command | Recorded result |
| --- | --- | --- | --- |
| `ab0dba56eaa837d1db3aaea0df2ed3d2773d65d1` | the Go backend | `go test -race -timeout=60m -json -count=1 ./backend/... ./cmd/...` (Linux container, real PostgreSQL with `KHA41_REQUIRE_POSTGRES=1`, pinned rules worker at `/workspace/build/rules-worker/worker.mjs`, `DAC_OVERRIDE` and `DAC_READ_SEARCH` dropped) | 797 passing test and subtest outcomes, zero failures, zero individual skips, no data-race report; integration package 1453.141 s; exit code 0 |
| `1e08868d71e3105288ba59af24f55ea3df310593` | the product and browser sources | `pnpm exec playwright test tests/e2e/account-online.spec.ts tests/e2e/online-ui.spec.ts tests/e2e/online-requests.spec.ts tests/e2e/online-clients.spec.ts --project=chromium --reporter=json` (fixture account build, real PostgreSQL-backed service, `ONLINE_FIXTURE_STRICT=1`, `ONLINE_FIXTURE_UI_INVITE_PATH=/invite/{invitationId}`, `KAMKM_E2E_PORT=5397`) | 21 expected, 0 skipped, 0 unexpected, 0 flaky; 231.977 s |

The Go sources are identical between the two pins. The browser pin is the
later commit and also carries the product changes under `src/`. The rules
worker is the pinned private bundle (chessops 0.15.1, rules policy
`online-rules/1`); the recorded worker SHA-256 is
`13478854ff453216d915558e9caf87c3aa05891321003e3ed8f5ab7bb139f078`.

`docs/evidence/online/KHA-80-integration.json` was produced by importing the
assembled log through `scripts/online/integration-suite.mjs`
(`parseGoTestJson` / `mapScenarios`). No new `pnpm run online:integration`
invocation is claimed for it.

## Current result

| Item | Result |
| --- | --- |
| Evidence ledger | **0 passed, 0 failed, 0 blocked, 16 partial, 46 not run** |
| Approved acceptance contract | unchanged: 60 scenarios `not_run`, 2 planning approvals |
| Recorded Linux race run (database pin `ab0dba56`) | 797 passing outcomes, 0 failures, 0 individual skips, exit 0 |
| Recorded fixture Chromium run (browser pin `1e08868`) | 21 cases passed, 0 skipped, 0 flaky |
| Current working tree | focused checks only (see the current-tree limits); no current-tree Linux race and no current-tree Chromium run |
| Release gates | `blocked` (exit 1) for both `friend` and `queue` |

## What the ledger records

Every partial record names the tested commit, the exact command, the expected
behaviour and the observed result. All named tests below passed in the
recorded run; each scenario stays `partial` because the named tests exercise
only part of the approved scenario.

| Scenario | Recorded source | Recorded mapped tests (all passed) |
| --- | --- | --- |
| FRI-01 | browser `1e08868` | a guest accepts a friend invitation and both browser clients observe the same accepted move; a consumed invitation cannot be accepted twice and a guest without a credential is refused |
| FRI-03 | browser `1e08868` | a guest accepts a friend invitation and both browser clients observe the same accepted move |
| MAT-03 | database `ab0dba56` + browser `1e08868` | `TestPostgresOnlineInFlightMoveRetryReturnsOriginalReceipt`; `TestPostgresOnlineNonMemberCannotReadOrCommand`; the guest-accepts browser case |
| MAT-04 | database `ab0dba56` | `TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut`; `TestPostgresOnlineCommandThatWaitsPastTheReplyDeadlineAborts` |
| MAT-11 | database `ab0dba56` | `TestPostgresOnlineDrawConsentIsBoundToTheExactOffer`; `TestPostgresOnlineTakebackConsentIsBoundToTheExactOffer` |
| MAT-12 | browser `1e08868` | the consumed-invitation browser case |
| HIS-10 | database `ab0dba56` | `TestPostgresOnlineStoredStateNeverContainsTheCredentialSecret`; `TestPostgresOnlinePublicReplayIsPublicAndLiveStateIsNot` |
| ARC-02 | database `ab0dba56` | `TestPostgresOnlineAcceptedSetupRetrySurvivesUnavailableWorker`; `TestPostgresOnlineHTTPCannotInvokeTheTrustedDeadlineReconciliation` |
| ARC-03 | database `ab0dba56` | `TestPostgresOnlineExpiredCredentialIsRejectedAfterTheLockWait`; `TestPostgresOnlineRevocationDuringRulesEvaluationRejectsTheCommand` |
| ARC-04 | database `ab0dba56` + browser `1e08868` | `TestPostgresOnlineInFlightMoveRetryReturnsOriginalReceipt`; `TestPostgresOnlineAcceptanceRetryReturnsTheStoredReceipt`; `TestPostgresOnlineExpiredCredentialCannotReplayAnAcceptedOperation`; the guest-accepts browser case |
| ARC-05 | database `ab0dba56` | `TestPostgresOnlineNonMemberCannotReadOrCommand`; `TestPostgresOnlineAccountSessionRevocationRejectsBeforeTokenExpiry`; `TestPostgresOnlineRevokedGuestCredentialStopsEveryAccess` |
| ARC-06 | database `ab0dba56` + browser `1e08868` | `TestPostgresOnlineGuestCredentialAuthorizesItsSeatAndReconnects`; `TestPostgresGuestSeatKeepsOneLiveCredentialAndOneOwner`; the consumed-invitation browser case |
| ARC-08 | database `ab0dba56` | `TestPostgresGuestSeatKeepsOneLiveCredentialAndOneOwner`; `TestPostgresOnlinePendingRevocationRejectsTheWaitingDuplicatePreflight` |
| ARC-09 | database `ab0dba56` | `TestPostgresOnlineAcceptedSetupRetrySurvivesUnavailableWorker` |
| ARC-10 | database `ab0dba56` | `TestPostgresOnlineDueDeadlineScanIsBoundedAndReturnsIdentifiers`; `TestPostgresOnlineTrustedReconciliationIsIdempotentUnderConcurrentSweeps` |
| ARC-11 | database `ab0dba56` | `TestPostgresOnlineTrustedReconciliationKeepsAnExpiredClockPendingWhileTheRulesServiceIsUnavailable`; `TestPostgresOnlineServerLifecycleSettlesADueMatchAndStopsOnRelease` |

The 46 remaining scenarios carry no record at all and stay `not_run`. The
report is `docs/evidence/online/KHA-80-integration.json`; the per-scenario
records are in `docs/evidence/online/records/`.

## The two ledger rules

The ledger still refuses a stale pass. It simply does not fire on the
current records:

- a record whose commit is **not an ancestor of the tested tree** is not a
  pass. The earlier record set cited the author-worktree commits `e283d271`
  and `9c6bc799`, which are not ancestors of this branch, so those records
  were counted as failures. The current records cite `ab0dba56` and
  `1e08868`, which are ancestors of HEAD, so they are counted as evidence
  for their scenarios;
- a record whose scenario **failed in the newest run** is not a pass. The
  newest recorded run contains no failed scenario, so no record is
  downgraded today.

Both rules still apply to every future run.

## Current-tree limits

The two pins are reachable history, but they do not certify the current
working tree.

- After the published `7caaef4` snapshot the working tree carries
  uncommitted changes to the backend, product, browser-test, CI-tooling and
  documentation sources: 88 tracked files differ from HEAD (+14803/−2710)
  plus new untracked sources. The recorded race and browser runs predate
  those changes.
- The current tree has focused verification only, recorded in
  `docs/evidence/online/assembled-verification.md`: `go build ./...`, `go vet`
  over `./backend/queue ./backend/httpapi ./backend/integration
  ./backend/serverapp/`, `go test ./backend/queue ./backend/httpapi
  ./backend/invite ./backend/cohort ./backend/serverapp -count=1`, `pnpm vitest
  run src/online` (27 files, 446 tests, no failure and no skip), the
  operations/tooling Node selection (222 tests), `pnpm run typecheck`, `pnpm
  exec eslint . --max-warnings 0`, `pnpm run build` and `git diff --check`.
- No current-tree Linux `go test -race` and no current-tree Chromium run is
  claimed. A database-backed and a browser run on the current tree are still
  required before any scenario can be closed on it.
- Both release gates still evaluate to `blocked`.

## Real browser clients

The recorded browser run at `1e08868` passed all 21 cases with zero skips,
failures and flaky results. The cases that feed the ledger through
`scripts/online/browser-map.json` are the guest-accepts case (FRI-01,
FRI-03, MAT-03, ARC-04) and the consumed-invitation case (FRI-01, ARC-06,
MAT-12).

The earlier five-case table (four passed, one skipped) is history: the skip
was the invitation-link route, and the newer run records "the production
interface renders the invitation link" as passed, together with the signed-in
account cases "a signed-in browser enters the queue and the cutoff commits
the browser engine", "two explicit entries of one signed-in browser are
visible at the same time" and "the queue asks a signed-out browser to sign in
and keeps friend play".

## Earlier checkpoints (history, not the current result)

At author-worktree commit `9c6bc79` (on top of the integrated service
`3d63aab`) a run executed 163 Go integration tests and every test passed. That
commit is not an ancestor of this branch, so the ledger does not count it.
The scenario table below is that checkpoint; the same scenarios are recorded
as `partial` today.

| Scenario | Mapped tests | Result at that checkpoint |
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

The earlier failed and incomplete attempts of the assembled history are listed
in `docs/evidence/online/assembled-verification.md`: an interrupted Windows
full backend attempt with a guest-credential failure, a first Linux race
attempt stopped by Go's default ten-minute package timeout, a race attempt on
`77b51a7` with 788 passing outcomes and one failure caused by a test setup
error, a historical default browser suite with 76 passes and two engine/play
failures, and a fixture browser run on `3b5ee2e` with 20 passes and one
failure caused by a stale assertion. None of them is counted as green.

### The mixed-control test is not a current failure (history)

An earlier author-worktree run failed on
`TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction`:

```
--- FAIL: TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction (2.38s)
    online_history_test.go:371: execute op-move-2: online: participant does not control seat
```

That failure belongs to an older form of the test. The current source of the
test (`backend/integration/online_history_test.go:445`) hands the agent seat
its lease and submits the agent move through that lease; it is unchanged
between the pin `ab0dba56`, HEAD `7caaef4` and the working tree, and the
recorded run at `ab0dba56` records it as `pass`. The production sources it
exercises have changed since the pin, so the pin does not re-certify it for
the current tree.

### A flaky test to look at (history)

One of three author-worktree full-package runs failed on
`TestPostgresOnlineUpdatesStreamDeliversTheCanonicalSnapshotAndTheNextVersion`
while the whole package ran; the same test passed three times in isolation
and in two later full-package runs, so the failure was timing sensitive under
load rather than a deterministic defect. The recorded assembled run at
`ab0dba56` contains that test with the outcome `pass`. A flaky stream test
weakens the evidence of every run that includes it.

## Reproduction

The exact commands of the recorded runs:

```sh
# Database pin ab0dba56 — Linux container, real PostgreSQL, pinned worker.
# The container dropped DAC_OVERRIDE and DAC_READ_SEARCH.
KHA41_TEST_DATABASE_URL=<local fixture> KHA41_REQUIRE_POSTGRES=1 \
KHA66_WORKER_ENTRY=build/rules-worker/worker.mjs \
  go test -race -timeout=60m -json -count=1 ./backend/... ./cmd/...

# Browser pin 1e08868 — fixture account build, real PostgreSQL-backed service.
ONLINE_FIXTURE_DESCRIPTOR=<descriptor> ONLINE_FIXTURE_STRICT=1 \
ONLINE_FIXTURE_UI_INVITE_PATH='/invite/{invitationId}' \
KAMKM_E2E_PORT=5397 \
  pnpm exec playwright test tests/e2e/account-online.spec.ts \
    tests/e2e/online-ui.spec.ts tests/e2e/online-requests.spec.ts \
    tests/e2e/online-clients.spec.ts --project=chromium --reporter=json

# The ledger reads the approved contract read-only and never edits it.
node scripts/online/evidence-ledger.mjs      # print the counts
pnpm run online:evidence                    # rewrite docs/evidence/online/ledger.json
```

`pnpm run online:integration` runs the Go integration package against a real
database, maps the results onto the approved scenarios and writes
`docs/evidence/online/KHA-80-integration.json` plus one evidence record per
covered scenario. It needs a real PostgreSQL fixture, the built rules worker
bundle and the browser fixture; a new invocation on the current tree has not
been made and is not claimed here.

## Not exercised here

- Native assistive technology and the interface acceptance scenarios. The
  ledger closes a `UX` scenario only with `native` evidence, and every `UX`
  scenario is `not_run`.
- Deployed-host measurements: the Apache streaming, CSP/CORS and TLS
  behaviour and the sustainable client and game load (`ARC-13`, `ARC-14`)
  remain `not_run`. The checked-in load report measured the rejection path
  and is not serving-capacity evidence.
- A released cohort and the owner release decision (`REL`); the ledger closes
  a `REL` scenario only with `owner` evidence, and both gates are `blocked`.
- The public queue scenarios `QUE-01` … `QUE-14` carry no record. The
  recorded browser run exercised a queue entry, a waiting-entry reload and
  the signed-out queue gate, but no queue scenario is recorded as partial or
  passed.
- Provider-backed agent execution against a paid provider. The recorded local
  run proves the private rules worker path only.
