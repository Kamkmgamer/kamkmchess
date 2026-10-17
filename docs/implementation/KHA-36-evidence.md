# KHA-36 move parsing and recovery budget evidence

## Scope

The KHA-36 candidate added the deterministic reply parser and per-turn recovery budgets in [`src/moves/`](../../src/moves/index.ts) for [KHA-36](https://linear.app/kamkm/issue/KHA-36/implement-move-parsing-and-independent-recovery-budgets). The module classifies one completed choice-zero answer into exactly one turn effect: a normalized coordinate move, an explicit model resignation, or a formatting failure that asks for clarification. It spends at most four illegal-move attempts per pending chess turn, at most three independent automatic formatting corrections, and authorizes a manual Retry as exactly one extra request without refilling anything. KHA-53 moved reply eligibility into the controller's request fence; `src/moves/` no longer owns a reply fence.

The module never fetches, streams, retries, reads credentials, chooses a model, owns the clock, applies a result, or persists state. It never repairs JSON, infers a command from narrative, reasoning, a plan, another choice, or history, chooses a promotion piece, lists legal moves, or suggests a replacement. The rules adapter remains the only legality authority; this module only words a violation the application can already prove from its own board.

Controller and interface wiring are unchanged. The match controller still accepts coordinates through its existing intents, and the placeholder page still does not call the controller. Wiring parsed turns into playable play belongs to the controller and interface tickets. This candidate does not complete KHA-36.

All 79 product acceptance cases remain `not_run`. No native screen-reader, journey, concurrency, or live-provider subrun was performed. Completing the code does not certify them.

## Verification

Candidate base: `ada0f8f`.

| Command | Expected result | Observed result |
| --- | --- | --- |
| `pnpm run typecheck` | Both TypeScript projects accept the new module. | Passed. `tsconfig.app.json` and `tsconfig.node.json` both passed. |
| `pnpm run lint` | ESLint reports zero warnings and zero errors. | Passed. `eslint . --max-warnings 0` reported no problems. |
| `pnpm run test` | Every offline fixture passes, including the new adversarial parser, refusal, budget, and fencing fixtures. | Passed. 344 tests across 25 files. The two new files add 39 tests: `src/moves/parse.test.ts` and `src/moves/budgets.test.ts`. |
| `pnpm run build` | Typecheck, production build, and notice generation succeed. | Passed. Vite 8.3.4 transformed 15 modules and wrote `dist/index.html`, one CSS asset, and one JS asset; distribution notices were written. |

## What the fixtures cover

`MOV-01`, `RUL-01`: one fenced JSON object with an optional plan and harmless extra fields, retained fields, coordinate whitespace and case normalization, castling by king squares, en passant by pawn squares, explicit promotion including underpromotion, and a missing promotion suffix that becomes a clarification rather than an illegal attempt.

`MOV-02`: conflicting duplicate `move` keys, identical duplicate action keys, move beside `resign`, move beside an explicit `resign: false`, competing explicit answers, an explicit final `Move:` line with decoration, five forms of unrepaired broken JSON, a second code fence, out-of-shape coordinates, and no-action assertions proving that narrative, plan, and non-string `move` values never act.

`MOV-04`: legal acceptance resetting budgets, castling, en passant and underpromotion applied through the rules adapter, rule-specific violation wording without a legal list, exactly four illegal attempts with immutable loss on the fourth, per-attempt model attribution, and a reply that stops being legal after the position advances.

`MOV-05`: three automatic formatting corrections then a Retry-or-Switch pause, formatting and chess budgets staying independent, a recovered illegal move spending only a chess attempt, a missing promotion spending only a formatting correction, a manual retry that does not refill the format budget or erase illegal attempts, and an ordinary model switch preserving spent counters.

`MOV-06`: `{"resign":true}` and explicit final refusal statements resigning immediately without spending a correction, a seven-case negative corpus covering quoted, block-quoted, hypothetical, attributed, and historical refusal text, provider error and filter text that never arrives as an answer, and replies that both move and refuse asking for clarification.

`MOV-07`: technical interruption preserving every spent counter while the clock keeps running, respect for a known retry-after value, and Stop, clock expiry, and stale replies spending no attempt and adding no increment.

`MOV-08`: an unhandled reply accepted once and refused afterwards, superseded generations, earlier position revisions, foreign segments, a newer ownership epoch, and a duplicate reply of an accepted position all refused, so a repeated FEN cannot revive eligibility.

## Not covered here

Live provider compatibility checks, native and assistive-technology acceptance, journey-level interface evidence, and concurrency evidence against a running controller remain `not_run` in `docs/spec/mvp-acceptance.json`. No provider credentials or provider API requests were used. These results establish offline local behaviour only.
