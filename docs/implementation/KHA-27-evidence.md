# KHA-27 rules adapter evidence

## Public API

The public entry point is [src/rules/index.ts](../../src/rules/index.ts). It exposes validated FEN positions, legal coordinate transitions, legal coordinate enumeration for local proof analysis, a versioned repetition ledger, and observed ending facts.

parsePosition validates all six FEN fields and current-state consistency. It preserves the imported FEN, declared rights, ineffective en-passant targets, and counters. Counter strings stay outside chess.js numeric state. chess.js receives normalized 0 and 1 counters; the adapter updates exact counters with BigInt.

repetitionIdentity uses the placement, side to move, castling rights, and en passant only when a legal en-passant capture exists. It stores the full identity string rather than a hash. The ledger counts each identity from the imported starting position and can restore its JSON snapshot.

applyCoordinateMove applies legal chess moves without repetition or halfmove cutoffs. Actual match code must inspect observeEndingFacts before accepting a transition. Proof analysis can use the same legal transitions without stopping at game draw thresholds. The API does not assess deadness or latch a match result.

## Deterministic evidence

The independent expected fixtures live in [src/rules/rules.test.ts](../../src/rules/rules.test.ts). They cover both castling directions for each color, castling through check, king safety, legal and pinned en passant, all four promotions, rook-right changes, all six FEN fields, a current-state-valid board with 18 pieces including 16 non-king pieces, exact large counters, and repetition equivalence.

| Expected behavior | Observed result |
| --- | --- |
| The 18-piece custom board parses without a piece-count cap; counters 999999999999999999999 and 900719925474099312345 remain exact. | Fixture passed with 18 pieces and unchanged counter strings. |
| chess.js 1.4.0 may round large counters and omit ineffective en passant during serialization. The adapter must preserve the imported FEN. | The direct library control rounded the halfmove counter to 100000000000000000000, rounded the fullmove counter to 12345678901234567000, and dropped e6; Position.fen retained both original values and e6. |
| A legal en-passant target changes repetition identity. An ineffective or pinned target does not. Castling rights do change identity. | All equivalence and inequivalence fixtures passed. |
| The starting position counts once; the second and third visits raise the count to two and three. | Both the knight-cycle and imported ineffective-EP cycle reached three. A JSON-restored ledger retained the full count map. |
| A quiet move from halfmove 99 reaches 100. Checkmate on that move takes precedence. | The 99 control remained ongoing, the ordinary 100 control reported hundred-halfmoves, and the g6g7 boundary fixture reported checkmate with hundredHalfmoves: true. |
| Promotion requires an explicit piece, and legal enumeration includes queen, rook, bishop, and knight choices. | Missing promotion threw IllegalMoveError; all four legal choices appeared and applied. |

## Build and method

Environment: Node v24.22.0, npm 11.19.1. The production build ran with npm run build.

The build passed both TypeScript projects, transformed 15 modules, emitted the [app bundle](../../dist/assets/index-CE2xj8Mp.js), and generated [third-party notices](../../dist/THIRD_PARTY_NOTICES.txt) and [dependency inventory](../../dist/DEPENDENCY_INVENTORY.json). The notice contains the chess.js@1.4.0 BSD-2-Clause license. Vite does not bundle the rules entry yet because no application module imports it; the focused tests import and exercise it directly.

| Command | Expected | Observed |
| --- | --- | --- |
| npm test -- src/rules/rules.test.ts | All rules fixtures pass. | 31 tests passed. |
| npm test | Full fixture suite passes. | 31 tests passed. |
| npm run lint | No lint errors. | Passed. |
| npm run build | Typecheck, production build, and notices complete. | Passed. |

The application acceptance matrix remains unchanged, and RUL acceptance statuses remain not_run. These fixtures do not certify native browsers, assistive technology, storage/Undo integration, model requests, live providers, deadness proof analysis, or match-result ordering. Those subruns remain unrun.
