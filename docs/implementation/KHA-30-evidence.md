# KHA-30 proof-checker evidence

## Scope and status

This records the deterministic checker in [src/proofs](../../src/proofs/index.ts). It does not implement Worker search, graph generation, checkpoints, controller adjudication or prompt integration. The checker uses the public [KHA-27 rules adapter](../../src/rules/index.ts) for legal transitions and checkmate facts. It does not execute the Rust solver or use an external solver library.

KHA-27's formal Standards and Spec reviews completed with zero findings at public commit `786cfbb`, using reviewed source `cdfe09c1553b32251ac0f8a2e4632438d82d7470`. PR 3 is ready with a 5/5 signed summary. The native, editor, storage and controller acceptance gate remains unrun. This evidence does not claim KHA-30 or ADJ acceptance. The acceptance matrix remains `not_run`.

## Query and evidence rules

`P(color, position)` means that both sides may cooperate along legal moves until `color` delivers checkmate. Hypothetical paths ignore future repetition and halfmove draws. Global deadness requires excluding both colors. A timeout query asks only whether the opponent of the expired color can mate.

Each query records the exact six-field FEN and binds game, segment, revision, analysis generation, ownership epoch, schema, checker, rules adapter and predicate versions in a deterministic full-field identity. Board keys use full canonical strings with placement, side to move, castling rights and legally usable en-passant. They omit counters for hypothetical reachability. The checker indexes states by those complete strings and compares regenerated full target strings directly; no hash or hash index participates, so a hash-collision fixture does not apply. Rights and legally usable en-passant controls verify state distinctions.

The checker snapshots each query and evidence record from own enumerable data descriptors. It rejects accessors, sparse evidence arrays and accessor-backed array entries. It copies and normalizes nested moves and certificate successors before replay or graph comparison. Query parsing, identity calculation, evidence checks and the returned identity use the same query snapshot. The checker returns no references to caller-owned objects.

The [checker](../../src/proofs/checker.ts) accepts a positive witness only after replaying every coordinate through `legalMoves` and `applyCoordinateMove` and observing intended-color checkmate. An empty witness is accepted only if the root already is that checkmate. The negative format is `closed-successor-set`. The checker regenerates every legal successor, compares its move and complete target key, requires every state to be reachable from the root, and rejects a target checkmate. Global deadness checks both colors; timeout checks the opponent only. Missing evidence and configured traversal limits return `non-result`. Corrupt, stale, incomplete, wrong-color or illegal evidence is rejected.

The module has no provider or prompt dependency. Its outputs are not model advice. A payload-separation integration assertion remains for the future provider/controller work.

## Fixture outcomes

The [focused test file](../../src/proofs/checker.test.ts) exercises these expectations:

| Control | Independent expectation | Checker observation |
| --- | --- | --- |
| Four-state forced cycle | No mate by either color. The research certificate closes at four states and four legal edges. | Accepted as `dead`. Omitted edges, truncated states and noncanonical keys are rejected. |
| Locked pawn wall | No mate by either color. Independent research exhausted 768 states and 3,808 transitions and cross-checked move sets with chess.js and chessops. | The checker regenerates all 3,808 transitions and accepts the 768-state certificate as `dead` while its public monotonic clock is held stable for this correctness fixture. |
| Knight assisted by rook | Both colors have cooperative mating witnesses. The white side also has the researched one-move `d6f7` mate. | White and black witnesses replay to checkmate. |
| Asymmetric wall and mirror | White mates in the first position; black mates in the color/rank mirror. The opposite-side negative claims are not trusted as certificates. | Both positive witnesses are accepted. Missing negative evidence returns `non-result`. |
| Bare king and rook | The rook side has a mating witness. The bare king's negative claim has no submitted proof. | Rook-side witness is accepted. Bare-king query remains `non-result`. |
| Two knights | A 57-ply cooperative witness exists. The opposite-side negative claim is unsupported here. | Positive witness is accepted. Unsupported negative query remains `non-result`. |
| Halfmove counter 99 | The approved hypothetical predicate still accepts a legal path to mate even when actual play would reach its draw threshold first. | The researched witness is accepted. A separate boundary fixture confirms checkmate at 100 halfmoves is still recognized. |
| Castling, en-passant and promotion closure edges | Every legal successor must appear in a negative certificate. | Certificates omitting each tested special move are rejected. A promotion mating witness is replayed and accepted. |
| Accessor-backed query and evidence data | Identity and replay must use the same validated values; getters cannot change queried positions, moves or certificate edges between reads. | Position-FEN, witness, nested move, node, successor and array-index accessors are rejected. Equivalent ordinary data controls are accepted. |
| Checker elapsed-time controls | A valid witness can be accepted within budget; elapsed-budget exhaustion remains unknown. | A stable public clock accepts the valid witness. A controlled 5,001 ms elapsed reading returns `non-result` with `time-limit`. |
| 21-origin hazard | The exact custom FEN may be parsed, but no unchecked Rust move generator may run. | The FEN is used only to create a query; missing evidence returns `non-result` before move generation. |

Positive path sources and the independent controls are recorded in [exact adjudication research](../../research/exact-adjudication-coverage.md), [dependency research](../../research/chess-dependencies.md), and [their experiment artifacts](../../experiments/exact-adjudication-coverage/native-results.json). The locked-wall comparison is in [the chess dependency probe output](../../experiments/chess-dependencies/probe-output.txt). The copied positive paths are replayed again by this checker. Solver negative labels are not treated as proof.

## Build and method

Environment: Node v24.22.0 and npm 11.19.1. No credentials, live models, network services or paid requests were used.

| Command | Expected | Observed |
| --- | --- | --- |
| `npm test -- src/proofs/checker.test.ts` | Focused proof fixtures pass. | 25 tests passed in the final focused run. |
| `npm run lint` | No lint errors. | Passed in the final full check. |
| `npm test` | Complete offline fixture suite passes. | 71 tests passed across 3 files. |
| `npm run typecheck` | App and node TypeScript projects pass. | Passed in the final full check. |
| `npm run build` | Typecheck, Vite production build and notices complete. | Passed in the final full check. Vite built 15 modules and wrote [the app](../../dist/index.html), [third-party notices](../../dist/THIRD_PARTY_NOTICES.txt) and [dependency inventory](../../dist/DEPENDENCY_INVENTORY.json). |

The final `npm run check` command ran lint, all 71 tests, typecheck, the Vite production build and notice generation. It exited 0.

## Unrun work and limits

The checker retains a five-second time bound, a 10,000-state and 100,000-edge certificate bound, and a 100,000-ply witness bound. Limit exhaustion returns `non-result`. The 768-state correctness fixture controls `performance.now()` only during the public checker call; it still runs the real rules adapter and regenerates every legal successor. Separate public API controls check acceptance with a stable clock and `non-result` after a controlled 5,001 ms reading. Production calls use the real monotonic clock and can return `non-result` for a valid certificate when the runtime is slow or contended. That is an unknown result, not a verdict, and the checker does not promise a universal completion time.

Native browser, Worker startup, cancellation, memory/OOM behavior, assistive technology, live provider and model tests remain unrun. Controller result latching, pending-game persistence, stale-result fencing and checkpoint recovery are outside this checker commit. KHA-27's formal reviews cover the trusted transition and checkmate assumptions; its native, editor, storage and controller acceptance gate remains unrun. Those product gates and the remaining KHA-30 work must complete before any ticket acceptance claim.
