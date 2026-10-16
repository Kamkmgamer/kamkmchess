# KHA-31 proof-search evidence

## Scope

KHA-31 adds a cooperative graph-search API, checkpoint validation, a browser Worker entry point, and a separate IndexedDB store for resumable search checkpoints. The search lives under `src/proofs/search/` and is exported through `src/proofs/index.ts`. The store lives in `src/storage/proof-search.ts` and is exported through `src/storage/index.ts`.

The proof-search store uses its own database. KHA-31 does not change the existing game or archive storage schema, result constraint, public types, or quarantine behavior. The application placeholder does not start the Worker or connect search to a controller.

The checker fixture at `src/proofs/checker.test.ts` has a 30,000 ms Vitest timeout for the 768-state closure correctness case. Its logical checker clock stays frozen for that test. The change affects only the test runner guard. It does not change the fixture assertions or any production search or checker limit.

## Verification record

The runtime, fixtures, package files, and build configuration in this publication matched the reviewed integration snapshot byte-for-byte before the results below were reused.

| Command | Result |
| --- | --- |
| `npm run lint` | Passed with no lint warnings. |
| `npm run test -- --no-file-parallelism` | 194 of 195 tests passed. The 768-state checker fixture exceeded Vitest's default 5,000 ms per-test guard after about 6.4 seconds under host CPU contention. |
| `npm run test -- src/proofs/checker.test.ts -t "checks the 768-state dead pawn wall closure under a controlled budget"` | After the fixture guard changed to 30,000 ms, the targeted rerun passed: 1 passed, 24 skipped. |
| `npm run build` | Passed. The build includes both TypeScript projects and dependency notice generation. |

The serial attempt plus the focused rerun covered all 195 tests successfully across runs. There was no single 195-test all-green run after the guard change. The 768-state fixture tests checker correctness with a frozen logical budget; it does not measure a hardware speed target.

## Search behavior

Fixtures call the public query, search, checker, and storage APIs. Accepted results pass through `checkProofEvidence`, which independently validates a positive witness or a complete closed successor set.

| Case | Observed result |
| --- | --- |
| Reviewed four-state cycle | Complete closure returned `accepted/dead` with 4 states and 4 edges. |
| 768-state locked pawn wall | Complete closure returned `accepted/dead` with 768 states and 3,808 edges. |
| Positive reachability | Search returned a witness that the public checker accepted. The promotion fixture found `a7-a8=B`. |
| Usable en-passant target | The canonical position retains the usable target and fullmove number. Search returned `accepted/mate-reachable`, and the checker accepted its witness. |
| Resumable checkpoints | Search version `kha31-cooperative-search/2` and checkpoint schema version `1` are recorded. Stale search versions restart from the saved query. |
| Corrupt graph edge | Validation regenerates the ordered legal successors and exact targets. Changing an edge and its matching parent to an illegal move returns `restart-required`; search reports a non-result. |
| Expanded-state completeness | Checkpoints retain first-discovery parents and validated expansion progress. Missing or incomplete state, edge, frontier, or parent data cannot grant a verdict. |
| Database upgrade | The proof-search database closes its connection when another tab requests a version upgrade. |
| Partial pass and cancellation | State-budget and cancellation outcomes remain non-results and retain validated progress for a later pass. |
| Five-second unknown fixture | The real time-budget fixture remains unknown. It does not return a verdict when the pass reaches the five-second budget. |

The default search pass allows 10,000 newly discovered states and 5,000 ms. A fresh pass counts its root as a discovered state; a resumed pass counts only new states. State and time limits, cancellation, an invalid checkpoint, or a checker rejection never establish a negative result. The checker currently limits accepted closures to 10,000 states and 100,000 edges.

The default time budget is cooperative. Browser scheduling and one synchronous move-generation or checker call can run past a deadline before control returns. The historical 128 MiB figure describes WASM linear memory in a separate solver experiment. It is not a JavaScript total-memory limit and this implementation does not enforce it.

The separate proof-search store hashes checkpoint content and writes state, frontier, and parent records in bounded chunks within one IndexedDB transaction. It reports a save only after transaction completion. Corrupt or incompatible checkpoints require a fresh search from the saved query when that query is available.

## Product and platform limits

All 79 product acceptance cases remain `not_run`. The Worker entry passes TypeScript compilation, but the placeholder does not call the Worker factory, so the production build contains no Worker artifact. This evidence does not certify Worker startup, MIME or CSP behavior, browser cancellation responsiveness, native IndexedDB behavior, mobile memory use, or production adjudication wiring. KHA-32 controller integration is not claimed.

## Source and build artifact

The published source commit and build artifact hashes are recorded in the [KHA-31 artifact manifest](../evidence/artifacts/KHA-31-cooperative-search-build.sha256.json). The manifest lists every file in the committed [production build ZIP](../evidence/artifacts/KHA-31-cooperative-search-build.zip).
