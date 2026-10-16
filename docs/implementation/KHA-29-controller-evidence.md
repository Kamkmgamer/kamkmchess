# KHA-29 serialized controller evidence

Status: deterministic controller slice implemented and locally verified. This record does not certify the complete KHA-29 issue, product acceptance, native behavior, or launch.

## Worktree and dependency commits

- Worktree: `C:\Users\Lenovo\.t3\worktrees\kamkmchess\t3-0de667d7`
- Branch: `t3/serialized-controller-core`
- Starting commit: `ca1b36343c6bd2008dd03709e031b8d96a41ce90`
- Rules dependency copies: `90ef6481d901ec8d0a473126bf91892680e41ef4` (source `6453943969af0b7b6ac7082fa456cbf6fbb03628`) and `0383ff8dd2f05e08d06e20b1d23f8026c9834095` (source `cdfe09c1553b32251ac0f8a2e4632438d82d7470`).
- Storage dependency copies: `d34126d26aa4d6f5e90d8e311fb85e43124fd0f6`, `6aaa16671300cb18cfb643332525b285b44a6281`, `946713599869fb0410ca99bdb1b0b5eccf112305`, `496e722645cd15aa7febe23ad056e162e73a181b`, and `75d9b2cef4751686b030a0330d52f62530eb7ae0` (the latter three correspond to source commits `7b4b3c0e987f642e5d88be2cd79ce378f6a52e35`, `0b1880b8b68d576e89685a544f21de74176a7a3f`, and `fe41fbe28c552f6f5a86c754ee6045c92605714`).
- Pending storage dependency: source commit `529134cdbd7ca051bc42491bfe70ecbcb91d9048` constrains final stalemate results to `winner: 'draw'`. This worktree does not include it. The controller already emits a draw for stalemate; the coordinator will integrate the storage constraint and rerun combined checks.
- Exact dependency pins include `chess.js` 1.4.0 and `fake-indexeddb` 6.2.5. `npm ci` passed after dependency integration.

## Public controller API

`src/controller/index.ts` exports `getOrCreateGameController`, configuration/setup/fence/snapshot/intent/request/result types, `GameControllerError`, and `modelConfigurationIdentity`.

One controller is registered per game ID for the page lifetime. It exposes `initialize`, versioned `dispatch`, `reconcile`, `snapshot`, and `subscribe`. Setup accepts White, Black, or Random human-side choice, a diagnostic-passed model selection, guest/account namespace, ownership epoch, and optional strict starting FEN and time control (default 15+10). Requests and asynchronous move intents carry a fence containing game, segment, side, persisted revision, board-position revision, request and analysis generations, ownership epoch, and a secret-free model configuration identity. Runtime dispatch accepts only model-turn start, Stop, human-move, and parsed model-move kinds; an unknown kind fails before the controller samples time.

All state-changing intents pass through a serialized queue and persisted revision/epoch check. `GameStore.commitCheckpoint` samples time and calls the controller's decision synchronously inside the persisted fence. The controller appends versioned event metadata from that decision sample, compares the active deadline (equality expires), and only publishes a candidate after the storage transaction completes. Predeadline moves anchor the next clock at decision time; commit delay is charged to that side. Aborted transactions publish no move or increment. Accepted-move events retain charged elapsed time, increment credit, next clock anchor, and full monotonic/wall/host-offset reference evidence. Final results use explicit precedence for checkmate, stalemate, threefold repetition, and the 50-move rule, latch immutably, and persist a paused clock while preserving its banks.

Restored running clocks remain non-actionable until absence reconciliation commits. Revisions increase independently from board position revisions, so a legal cycle back to the same FEN cannot revive an old request. Stop fences model work without pausing its clock. Setup terminal facts are evaluated inside the fenced decision and do not start a clock. Listener snapshot copies prevent subscribers from mutating controller state.

When a snapshot detects a reference discrepancy, the controller latches the first complete reading. Before accepting any actionable intent, it commits that reading as a `clock-reconciliation-required` event at the fenced decision time and blocks the intent. An aborted write leaves the checkpoint and journal unchanged; the next attempt still records the original discrepant sample even if its new sample is stable. Human moves, model moves, model-turn starts, and Stop remain blocked until an explicit successful reconciliation commits. A restored clock keeps its absence-recovery basis through discrepancy persistence and abort/retry; only a committed reconciliation clears it. A persisted timeout candidate with no active deadline is not sampled again, so a restored process clock cannot create a false monotonic regression after expiry.

## Fixture evidence

These are offline deterministic fixtures at the approved public controller/storage seams. They are not native or full product acceptance runs.

| Command | Result |
| --- | --- |
| `npm test -- src/controller/index.test.ts` | 26 passed |
| `npm test -- src/clocks/index.test.ts` | 15 passed |
| `npm test -- src/rules/rules.test.ts` | 31 passed |
| `npm test -- src/storage/storage.test.ts src/archive/archive.test.ts` | 34 passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed as the first stage of `npm run check` with zero warnings |
| `npm run check` | Passed: lint, 106 tests, both TypeScript projects, Vite 8.3.4 production build, and distribution notices |

The reproducible method is `npm run check`, which runs lint, Vitest, typechecking, the production Vite build, and notice generation. The observed build emitted [`dist/index.html`](../../dist/index.html), [`dist/assets/index-CE2xj8Mp.js`](../../dist/assets/index-CE2xj8Mp.js), and [`dist/assets/index-Dn1Kj2XK.css`](../../dist/assets/index-Dn1Kj2XK.css). This is the repository's current scaffold build; it does not yet wire the controller into UI composition or certify a playable application.

Controller fixtures exercise 15+10 setup and randomized side selection, remount reuse, terminal custom setup, exact/equal/late deadlines, delayed commit, abort, stale reply after Stop, repeated-FEN fencing, clock discrepancy, active and expired restore, timeout event time, checkmate/stalemate latching, paused final clocks, and clock evidence round-trip in accepted-move events. Expected and observed outcomes at the controller seam:

| Fixture path | Expected | Observed |
| --- | --- | --- |
| Before/equal/after deadline (`index.test.ts`, deadline boundary fixtures) | Predeadline action is eligible; equality and later expiry persist timeout candidate and no move. | Passed at 29,999/30,000/30,001 ms. |
| Delayed commit (`waits for the durable move commit...`) | Do not publish until transaction completion; charge elapsed commit delay to the next bank. | Passed; accepted snapshot and persisted bank include the delay. |
| Abort (`accepts no move or increment...`) | Abort leaves checkpoint/move list unchanged and credits no increment. | Passed; persisted and in-memory revisions remain at the last committed request. |
| Stop, repetition, and remount | Old request cannot apply after Stop, same-FEN return, or a second factory call/remount. | Passed; stale fences reject and one registered controller is returned. |
| Restore and closure/sleep fixture times | Do not grant fresh time or replay an abandoned reply; charge absence before enabling action. | Passed with deterministic wall/monotonic samples; expiration retains its original deadline event time. |
| Detected reference discrepancy | Preserve the discrepant preaction readings, block all intents, and resume only after explicit successful reconciliation. | Passed for anchor `(0, 1000)`, discrepant sample `(500, 2500)`, stable decision `(500, 1500)`, injected transaction abort, retry with the original evidence, and all four intent kinds. |
| Restored discrepancy and recovery | A persisted discrepancy must not discard the cross-process wall-time recovery basis; an unknown intent kind must not sample or mutate the game. | Passed with anchor `(5000, 1000)`, resumed sample `(100, 500)`, an aborted then persisted discrepancy, repaired wall time `21000`, recovered White bank `10000`, and a runtime unknown-kind rejection with unchanged sample count and archive. |
| Final facts | Checkmate/stalemate latch once; final clocks are paused and accepted move event keeps clock evidence. | Passed; later intents are rejected and persisted result/clock match the expected fixture. |

The fixture source is [`src/controller/index.test.ts`](../../src/controller/index.test.ts); dependency fixtures are in the clock, rules, storage, and archive module tests. Build and fixture results above are local artifacts for this commit, not native or live subruns.

## Remaining scope and acceptance status

The requested trace `MOV-08`, `CLK-01`, `CLK-02`, `CLK-03`, `CLK-04`, `CLK-05`, `CLK-07`, and `LIF-02` remains not certified; all 79 acceptance cases remain `not_run`. Exact deadness and proof-driven pending-result settlement are a KHA-32 integration gate; timeout stays pending and is not relabeled. Full Undo journeys/budget restoration are KHA-33. Reply parsing, protocol completion, and attempt budgets are KHA-36. Identity/model switching, UI wiring, cross-device behavior, and saved pending setup require their downstream modules. No fetch, live model request, credential, provisioned service, or spending was used. Native browser, sleep/closure, and assistive-technology checks remain unrun. This controller slice does not mark the whole KHA-29 issue done or claim launch readiness.
