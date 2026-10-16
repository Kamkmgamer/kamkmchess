# KHA-32 implementation evidence

## Scope

This change connects the controller to the KHA-31 proof Worker and its public checkpoint store. Controller checkpoints keep version 1 adjudication facts in the existing `extensions["kha32-exact-adjudication"]` section. The extension stores the workflow, status, ordered pending candidates, each canonical proof query, its position and event times, the clock snapshot at the event, any active deadline, and the bounded-pass attempt generation.

Setup callers can use `classifySetup` before model diagnosis or clock start. The controller saves unresolved setup with a stopped clock. A checked non-dead result makes the setup eligible for `startClassifiedSetup`, which also requires the current-session model diagnostic and an unchanged setup. A checked dead result saves a final dead-position draw with no clock.

After each nonterminal accepted move, the controller records a deadness candidate and fences moves and model-turn actions while the result is unknown. The active clock keeps running. `continue-adjudication` starts one bounded pass; `stop-adjudication` cancels the active pass. Unknown, corrupt, unsupported, canceled, resource-limited, and Worker failures stay pending. The controller checks every positive witness and complete closure again with `checkProofEvidence` before accepting it.

When a clock expires, the controller saves the original deadline, effective expiry time, zeroed bank, fence generation, timeout query, and candidate order. Earlier unresolved deadness remains first. A checked earlier deadness proof can settle only that earlier event; a non-dead result advances to the saved timeout candidate. A checked timeout witness produces a loss, while checked impossibility produces a draw. Existing final results remain immutable.

The production runner calls the existing module Worker factory and saves resumable search state through `openProofSearchStore`. A failed or unavailable Worker yields a non-result. The controller has an injected runner seam for deterministic fixtures. It does not fall back to blocking main-thread search.

## Verification

Environment: Node 24.22.0, npm 11.19.1, Vite 8.3.4.

| Method | Expected | Observed |
| --- | --- | --- |
| Controller and adjudication fixtures | Setup pending/checked setup, in-game pending, reload, Stop/Continue, ownership change, timeout proof, and earlier-deadness/later-flag ordering preserve saved facts | 8 adjudication controller tests passed. The existing 26 controller fixtures also passed with pending state and move fencing represented. |
| Focused integration command across controller, adjudication, proof checker/search, game/proof storage, and archive | All selected public-boundary fixtures pass | 117 tests passed across 8 files. |
| `npm run lint` | No warnings or errors | Passed. |
| `npm run test -- --no-file-parallelism` | All offline tests pass without checker-fixture timing contention | 231 tests passed across 13 files. |
| `npm run build` | TypeScript, Vite production bundle, and notices complete | Both TypeScript projects passed. Vite built `dist/index.html`, `dist/assets/index-CE2xj8Mp.js`, and `dist/assets/index-Dn1Kj2XK.css`; notice generation completed. |

The feature tests use independent expected positions and checked proof results. The Worker fixture seam supplies pass results; controller acceptance still replays the evidence with the production checker. Checkpoint reload tests use the public proof store and controller APIs. The existing 10,000-state and 5,000 ms search budgets were not changed.

## API handoff and limits

See the external worktree handoff at `D:/projects/kamkmchess/.scratch/implementation-swarm/KHA-32-api.md` for the controller methods, extension DTO, production Worker/checkpoint path, event ordering, and integration notes.

The current application UI has no controller caller, so no browser flow was added. The explicit setup classification path is additive. Existing `initialize(setup)` retains the KHA-29 immediate-start contract for existing controller callers; new setup flows that need exact pre-clock classification must call `classifySetup` and then `startClassifiedSetup` after the proof and diagnostic pass. The production Worker factory compiled in the build, but browser Worker startup, native IndexedDB behavior, and UI interaction were not run.

All 79 product acceptance cases remain `not_run`, including `ADJ-06`, `ADJ-07`, `ADJ-08`, `CLK-07`, `RUL-04`, and `RUL-07`. Native browser and assistive-technology journeys, live requests, cloud behavior, and whole-KHA-29 acceptance are not claimed. Exact analysis may remain pending; there is no completion-time promise for every position.
