# KHA-30 proof-checker evidence

## Scope and status

This records the deterministic checker in [src/proofs](../../src/proofs/index.ts). It does not implement Worker search, graph generation, checkpoints, controller adjudication or prompt integration. The checker uses the public [KHA-27 rules adapter](../../src/rules/index.ts) for legal transitions and checkmate facts. It does not execute the Rust solver or use an external solver library.

KHA-27 formal review and its native gate remain active. This evidence does not claim KHA-30 or ADJ acceptance. The acceptance matrix remains `not_run`.

## Query and evidence rules

`P(color, position)` means that both sides may cooperate along legal moves until `color` delivers checkmate. Hypothetical paths ignore future repetition and halfmove draws. Global deadness requires excluding both colors. A timeout query asks only whether the opponent of the expired color can mate.

Each query records the exact six-field FEN and binds game, segment, revision, analysis generation, ownership epoch, schema, checker, rules adapter and predicate versions in a deterministic full-field identity. Board keys use full canonical strings with placement, side to move, castling rights and legally usable en-passant. They omit counters for hypothetical reachability; no numeric hash acts as identity.

The [checker](../../src/proofs/checker.ts) accepts a positive witness only after replaying every coordinate through `legalMoves` and `applyCoordinateMove` and observing intended-color checkmate. An empty witness is accepted only if the root already is that checkmate. The negative format is `closed-successor-set`. The checker regenerates every legal successor, compares its move and complete target key, requires every state to be reachable from the root, and rejects a target checkmate. Global deadness checks both colors; timeout checks the opponent only. Missing evidence and configured traversal limits return `non-result`. Corrupt, stale, incomplete, wrong-color or illegal evidence is rejected.

The module has no provider or prompt dependency. Its outputs are not model advice. A payload-separation integration assertion remains for the future provider/controller work.

## Fixture outcomes

The [focused test file](../../src/proofs/checker.test.ts) exercises these expectations:

| Control | Independent expectation | Checker observation |
| --- | --- | --- |
| Four-state forced cycle | No mate by either color. The research certificate closes at four states and four legal edges. | Accepted as `dead`. Omitted edges, truncated states and noncanonical keys are rejected. |
| Locked pawn wall | No mate by either color. Independent research exhausted 768 states and 3,808 transitions and cross-checked move sets with chess.js and chessops. | The 768-state certificate is accepted as `dead`. |
| Knight assisted by rook | Both colors have cooperative mating witnesses. The white side also has the researched one-move `d6f7` mate. | White and black witnesses replay to checkmate. |
| Asymmetric wall and mirror | White mates in the first position; black mates in the color/rank mirror. The opposite-side negative claims are not trusted as certificates. | Both positive witnesses are accepted. Missing negative evidence returns `non-result`. |
| Bare king and rook | The rook side has a mating witness. The bare king's negative claim has no submitted proof. | Rook-side witness is accepted. Bare-king query remains `non-result`. |
| Two knights | A 57-ply cooperative witness exists. The opposite-side negative claim is unsupported here. | Positive witness is accepted. Unsupported negative query remains `non-result`. |
| Halfmove counter 99 | The approved hypothetical predicate still accepts a legal path to mate even when actual play would reach its draw threshold first. | The researched witness is accepted. A separate boundary fixture confirms checkmate at 100 halfmoves is still recognized. |
| Castling, en-passant and promotion closure edges | Every legal successor must appear in a negative certificate. | Certificates omitting each tested special move are rejected. A promotion mating witness is replayed and accepted. |
| 21-origin hazard | The exact custom FEN may be parsed, but no unchecked Rust move generator may run. | The FEN is used only to create a query; missing evidence returns `non-result` before move generation. |

Positive path sources and the independent controls are recorded in [exact adjudication research](../../research/exact-adjudication-coverage.md), [dependency research](../../research/chess-dependencies.md), and [their experiment artifacts](../../experiments/exact-adjudication-coverage/native-results.json). The locked-wall comparison is in [the chess dependency probe output](../../experiments/chess-dependencies/probe-output.txt). The copied positive paths are replayed again by this checker. Solver negative labels are not treated as proof.

## Build and method

Environment: Node v24.22.0 and npm 11.19.1. No credentials, live models, network services or paid requests were used.

| Command | Expected | Observed |
| --- | --- | --- |
| `npm test -- src/proofs/checker.test.ts` | Focused proof fixtures pass. | 20 tests passed. |
| `npm run lint` | No lint errors. | Passed in the full check. |
| `npm test` | Complete offline fixture suite passes. | 66 tests passed across 3 files. |
| `npm run typecheck` | App and node TypeScript projects pass. | Passed in the build. |
| `npm run build` | Typecheck, Vite production build and notices complete. | Exit code 0. Vite built 15 modules and wrote [the app](../../dist/index.html), [third-party notices](../../dist/THIRD_PARTY_NOTICES.txt) and [dependency inventory](../../dist/DEPENDENCY_INVENTORY.json). |

The repo's combined `npm run check` command ran lint, all 66 tests and typecheck. The production build was then run directly and exited 0.

## Unrun work and limits

The checker has a five-second time bound, a 10,000-state and 100,000-edge certificate bound, and a 100,000-ply witness bound. State and witness limit controls return `non-result`. A timed five-second exhaustion test was not run. These are checker bounds, not graph-search completion claims.

Native browser, Worker startup, cancellation, memory/OOM behavior, assistive technology, live provider and model tests remain unrun. Controller result latching, pending-game persistence, stale-result fencing and checkpoint recovery are outside this checker commit. Formal KHA-27 proof review must verify the trusted transition and checkmate assumptions before any result can be used for ticket acceptance.
