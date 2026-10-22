# Assembled online-play verification

This report separates measured local behavior from the broader acceptance and release requirements. The implementation branch starts at `67c672b`. The approved contract is [online-play-handoff.md](../../spec/online-play-handoff.md), with the unchanged scenario list in [online-play-acceptance.json](../../spec/online-play-acceptance.json).

The code scope covers KHA-69 through KHA-80, with operational and acceptance tooling for KHA-81 through KHA-85. Existing KHA-64 through KHA-68 and KHA-72 work is the starting point. Both online rollout gates remain off. No deployment, paid provider call or merge is part of this verification.

## How to interpret the evidence

Named automated cases establish only the behavior they exercise. The scenario records use `partial` for successful local subsets of a broader scenario. A failed case remains a failure. A skipped or absent case supplies no passing evidence.

The old records cited author-worktree commits `e283d271` and `9c6bc799`, which were not ancestors of the assembled branch. The assembled log import replaces those records with reachable source pins and actual named outcomes. It does not claim another invocation of the integration-suite wrapper, and it does not change the approved acceptance JSON.

## Completed backend suite

At `ab0dba56eaa837d1db3aaea0df2ed3d2773d65d1`, the assembled Linux run of `go test -race -timeout=60m -json -count=1 ./backend/... ./cmd/...` passed with 797 test and subtest passes, zero failures, zero individual skips and no data-race report. The integration package completed in 1453.141 seconds. Package-level skip entries were packages without tests. This is a historical source pin; later review fixes changed the working-tree backend sources.

The container used real PostgreSQL with `KHA41_REQUIRE_POSTGRES=1`, Node, psql and Python 3, and the pinned rules worker at `/workspace/build/rules-worker/worker.mjs`. It dropped `DAC_OVERRIDE` and `DAC_READ_SEARCH`. The suite exercised the actual fresh and stale deployment provisioner, live sequence-grant reader, and denied evidence write and removal. The worker SHA-256 was `13478854ff453216d915558e9caf87c3aa05891321003e3ed8f5ab7bb139f078`.

The command used image `kamkmchess-online-grants:local`, the network of `kamkmchess-kha67-local`, a read-only repository mount and separate Go build and module caches. Raw JSON and stderr are retained locally in `.scratch/online-swarm/assembled-ab0dba5-final-linux-race.jsonl` and `assembled-ab0dba5-final-linux-race-stderr.log`. The checked-in KHA-80 report imports these observed outcomes. Subsequent review fixes changed backend sources in the working tree, so this historical race result does not certify the current tree.

The assembled Windows `go vet ./backend/...` and `go build ./...` also passed after the workspace integration. The current-tree build and focused vet checks are listed below; neither is a replacement for the historical Linux race.

## Completed focused checks

At `1e08868d71e3105288ba59af24f55ea3df310593`, the assembled fixture Chromium run passed all 21 cases in 231.977 seconds, with zero skips, failures or flaky results. The command was `pnpm exec playwright test tests/e2e/account-online.spec.ts tests/e2e/online-ui.spec.ts tests/e2e/online-requests.spec.ts tests/e2e/online-clients.spec.ts --project=chromium --reporter=json`. It used the fixture account build, a real PostgreSQL-backed service, `ONLINE_FIXTURE_STRICT=1`, the published invitation path `/invite/{invitationId}`, and a dedicated preview on port 5397. The raw report is `.scratch/online-swarm/final-fixture-browser.json`. Subsequent review fixes changed product and browser-test sources in the working tree, so this historical browser result does not certify the current tree.

These cases exercised account credential use, queue fallback, concurrent entries, account changes and restoration, waiting-entry reload with the original cutoff, a delayed seat change across accounts, model switching during a request and between models, guest invitation creation and acceptance, shared legal moves, the historical review cursor during a live move, duplicate-click ownership and the signed-out queue gate. The parent stopped its fixture and preview after the run.

At `aad93ca`, the required-PostgreSQL Linux race selection passed seven top-level tests and two subtests in 80.685 seconds, with no individual skip. It exercised migration sequence high-water and called-state preservation, latest checkpoint ordering, safe flush logging and retry, lifecycle ownership while evidence removal fails, durable recovery evidence before gate release, generated runtime sequence permissions, and the real psql live-grant reader. The container dropped `DAC_OVERRIDE` and `DAC_READ_SEARCH`, so the evidence-denial regressions exercised an actual denied write or removal.

The Node grants and operations selection at `aad93ca` passed 93 tests. At `ec84214`, the parent provider runner and composition selection passed 127 tests. A fresh provider review of the same production code passed 186 focused tests, both TypeScript configurations and lint. Its causal controls distinguished a superseded settlement from recovery of the current decision's own accepted receipt.

At `82e099a`, the required-PostgreSQL private-game deletion regression passed. A fenced account receives `ErrAccountFenced`, and the refused deletion does not advance the game epoch.

At `3185920`, the assembled Node grants and operations selection passed all 96 tests, with no skip. The actual compose proof passed all 19 steps. It read the running PostgreSQL settings, detected a deliberately broken entrypoint, copied evidence onto the host-mounted backup path, checked `0700` directory and `0600` record ownership, and exercised lifecycle-lock contention, copy failure, lock failure and invalid restore identifiers. The operator scripts were checked out with LF line endings in the assembled Windows checkout.

The workspace author measured 1283 passing unit tests across 101 files on the eleven-commit workspace candidate through `cf947a4`, integrated at `3b5ee2e`. Both TypeScript configurations and lint passed. Causal controls reproduced held transport release, delayed cleanup of a replaced seat, account A-B-A recovery, acceptance across an account change and denied credential storage. These are author-worktree results, separate from the assembled checks.

The parent then ran `pnpm run check` at `1e08868`. Lint, all 1283 unit tests across 101 files, both TypeScript configurations, the production build, rules-worker bundling and distribution notices passed. No unit test skipped. Vite reported its existing large-chunk advisory. The regenerated rules-worker hash matches the full-race worker pin above. The raw log is `.scratch/online-swarm/assembled-1e08868-check.log`.

The production-build Chromium regression command `pnpm exec playwright test tests/e2e/online-workspace.spec.ts tests/e2e/engines.spec.ts tests/e2e/play.spec.ts --project=chromium --reporter=json` passed all 33 cases in 136.429 seconds at `1e08868`, with zero skips, failures or flaky results. It used a separate preview on port 5399. It covered the closed online entry, offline layout and icons, phone viewport and keyboard focus, engine download/cache, worker release and resume, final results, private model switching, Stop/Retry, move review, premoves and extended play. Both engine/play cases that failed in the historical run passed in this run. The raw report is `.scratch/online-swarm/assembled-1e08868-default-browser.json`.

The operations author ran `node scripts/online/restore-interruption-proof.mjs --json` at `59556cb` and passed all 47 steps. The proof, backup/privacy code and evidence helper match the integrated candidate. It measured actual process kills during the destructive import and after commit, missing-ledger refusal, no-sink refusal before import, and recovery using a protected evidence copy without a bundle or passphrase. Its separate crash after replay was staged through production privacy code. The local report is `.scratch/online-swarm/temp/final-r8-interruption.json`. The final predicate-only commit `5b6fbde` tightens the compose lock-failure assertion to the actual status and reason already measured by the parent; it does not change the interruption proof.

## Final review corrections

Foundation review 15 confirmed the prior source corrections and identified three remaining CI and evidence gaps. Commits `e3ea68a`, `cd104d7`, `74f70c5` and `0d5d4e9` add the sequence regressions to CI, compare the actual Python provisioner's emitted statements with the reviewed grant renderer plus twelve explicit defensive revokes, and narrow the unused-role probe claim to the table rights it actually reads. The sequence test also proves revoke-before-grant ordering. The capture uses dummy credentials and records SQL without executing it. It is a statement comparison, separate from the real PostgreSQL provisioning checks in the full race run.

At `0d5d4e9`, the parent ran the exact CI Node selection of runtime-grants, sequence, provisioner and operations tests: 106 passed, zero failed or skipped. `node deploy/runtime-grants-provision.mjs` reported zero findings, and scoped lint passed. Mutation checks reject a missing sequence grant, missing table grant, unexpected grant and missing defensive revoke. Logs are `.scratch/online-swarm/final-node-ops.log`, `final-provision-gate.log` and `final-ci-lint.log`. The live probe still does not read the unused roles' sequence or function rights, and its diagnostic no longer claims it does.

The final integrated source candidate is pinned at `2600cbe71bc85691798bdc75d7910fba8f819e8d`. Independent final spec review found no actionable gaps, and the standards review found no hard violations; one suggestion about unused wrapper exports was explicitly a judgment call. The final worker-close polling change also received a fresh independent review with no actionable finding. MiniMax M3.1 Flash Free was absent from the live OpenCode model catalog, so that narrow delegated review used `opencode/beam-free` at high variant. Earlier race and browser results remain historical measurements because later review rounds changed their source files.

## Final source pin and current-tree checks

The reviewed implementation and tests are committed at
`2600cbe71bc85691798bdc75d7910fba8f819e8d`. This evidence update is a later
documentation-only commit; it does not change the measured source. The final
engine-worker assertion passed the fresh full JavaScript check, three focused
repeats and the full offline Chromium run below.

At the source pin, a fresh `pnpm run check` passed 1,509 tests across 113
files, lint, both TypeScript configurations and the production build. Vite
retained its existing large-chunk advisory. The online-operations CI Node
selection passed 253 tests with zero skips, and its runtime-grant,
provisioning, service-wiring, cohort-enforcement, backup-coverage,
evidence-ledger and release-gate audits passed. The tagged online fixture test
passed. The check log is `.scratch/online-swarm/final-source-check.log`; the
CI Node log is `.scratch/online-swarm/current-node-ops.log`.

`go build ./...`, scoped `go vet` for the queue, HTTP API, integration and
server application packages, and focused backend package tests passed. The
focused package command was `go test ./backend/queue ./backend/httpapi
./backend/invite ./backend/cohort ./backend/serverapp -count=1`; the queue
package has no test files. No current-tree full PostgreSQL integration or
Linux race run is claimed.

The production-build offline Chromium regression command
`pnpm exec playwright test tests/e2e/online-workspace.spec.ts
tests/e2e/engines.spec.ts tests/e2e/play.spec.ts --project=chromium
--reporter=json` passed all 33 tests with zero skips, failures or flaky
results in 165.878 seconds. It ran with `KAMKM_E2E_PORT=55473`; the raw report
is `.scratch/online-swarm/final-offline-browser-worker-poll.json`. The final
worker-close assertion also passed three focused repeats before the full run.
Scoped ESLint for `tests/e2e/engines.spec.ts`, `git diff --check`, and checks
that the approved handoff and acceptance JSON were unchanged passed.

Both `node scripts/online/feature-gates.mjs evaluate --gate friend` and the
corresponding `queue` command still returned `blocked` (exit 1), with the
documented release decision, cohort, runtime-cohort, local/native/host
evidence and accepted friend-run requirements unmet. No deployment,
production host-capacity measurement, live cohort or owner release decision
was performed. The historical race/browser pins above and the bounded
current-tree checks here do not replace those acceptance requirements.

## Earlier attempts and their limits

- The Windows full backend attempt was interrupted and included a guest-credential test failure. It is not counted as a passing suite.
- The first later Linux race attempt used Go's default ten-minute package timeout and stopped before integration completed. Container root also bypassed the intended evidence-write denial. Neither result is counted as green.
- The Linux race attempt on `77b51a7` completed with 788 passing test or subtest outcomes, one failure and no individual skips. The sole failure arranged evidence-directory denial before `Bind`, so it failed before reaching the close operation under test. Test-only `aad93ca` moves denial after the successful bind. The focused Linux run above exercises the corrected premise. No production failure is inferred from that test setup error.
- The historical default browser suite had 76 passes and two engine/play failures under load. Separate retries passed unchanged, but those retries do not turn the original run into a passing suite.
- The assembled fixture browser run on `3b5ee2e` completed with 20 passes, one failure and no skips in 285.279 seconds. All nine account cases passed, including restored engine play, both model-switch cases, account isolation and the original-cutoff reload. The failure was a stale assertion that an enabled queue flag makes the signed-out queue button enabled. The account-only requirement and production account gate require it to stay disabled. This first attempt remains a failed run; the corrected test has a separate measurement.
- The historical native restore interruption proof at `a9f8031` passed 47 steps. Later operations corrections require their own named measurement.

## Unverified release requirements

Both final release-gate evaluations returned `blocked`, as expected. No owner release decision or cohort is recorded. The planning contract still has 60 implementation scenarios marked `not_run` and two planning approvals; this report and the partial records do not change that contract.

The generated evidence ledger reports 16 partial scenarios and 46 not run. These are implementation-evidence statuses, separate from the planning approvals in the unchanged contract.

Local Chromium, PostgreSQL and Docker checks do not establish native desktop or mobile assistive-technology acceptance, deployment-host capacity, delivered TLS/CSP/Apache streaming behavior, a released cohort or owner release approval. The checked-in load report measured the rejection path, with all responses `401`; it is not serving-capacity evidence. The load tool now refuses to record an all-rejection run as a serving measurement.

The native restore proof uses real process kills during import and after import commit. Its separate crash after removal replay is staged through production privacy code, followed by recovery with the real CLI. A local Docker engine measurement does not claim the Linux CI workflow has passed.

Shared health uses the documented per-dependency last-writer policy. Mixed healthy and unhealthy peers can alternate the shared checkpoint, while a broken instance remains locally closed. Checkpoint retention and deployed-host capacity remain operational work. Neither limit is a release approval.
