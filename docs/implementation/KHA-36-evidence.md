# KHA-36 parser and recovery policy evidence

This work adds the independent parser and recovery-budget policy in `src/model-replies/`. It starts from parent commit `605bd77` on the isolated `t3/deterministic-reply-parser` branch. It does not add the controller caller, apply chess moves, or accept clock/fence/result transitions. The controller integration remains for the root author to complete.

The public entry point is `src/model-replies/index.ts`. The parser consumes the public `ProtocolStreamResult` from `src/providers/protocols/index.ts`, requires a complete actionable result, and retains the original protocol result and exact answer/refusal text on each classification. It reads only the completed answer channel or a protocol-marked refusal. Coordinate parsing does not determine move legality; the current `Position` is used only to identify a pawn promotion that needs a suffix.

The versioned policy stores illegal attempts and automatic format corrections separately. It requires a controller eligibility attestation for current fence, uniqueness and pre-deadline status. Move policy events also require the controller's legal/illegal validation result. The policy returns data only. The controller must apply its output inside serialized event handling after its own checks. Static correction text comes from strict rejection categories and contains no replacement move or legal-move list.

## Fixture coverage

`src/model-replies/model-replies.test.ts` tests the public module entry point with independent expected classifications, moves, counters and policy outcomes. One parser fixture comes from the public Chat decoder itself. The fixtures cover:

- JSON, optional plan, ignored extra fields, one code fence, `Final Move` and standalone coordinate fallbacks.
- Coordinate normalization, castling and en-passant coordinates, all four promotion suffixes, and missing promotion only for a plausible current-side pawn promotion.
- Conflicting/duplicate keys, malformed JSON, move-plus-resignation, competing answers, missing move, invalid plan/resign fields and channel mixing across answer, refusal, plan, reasoning and other choices.
- Explicit completed refusal/resignation, inline and multiline quoted/history/hypothetical refusal controls (including historical `Final Answer:` and `Final Move` markers), standalone refusal with trailing LF/CRLF boundary whitespace, standalone `Final Answer`/`Final Decision`/`Final Move` refusals, and incomplete, filtered, tool-only, HTTP-error and provider-error outcomes.
- Four illegal attempts with three automatic corrections, three independent format corrections and no chess loss on exhaustion, technical/switch preservation, one-request manual Retry, legal-move reset, and stale/stop/expiry/duplicate/superseded/terminal ineligibility.

These fixtures verify module behavior. They do not pass the corresponding product acceptance cases because no controller caller is wired here. `docs/spec/mvp-acceptance.json` remains unchanged; all 79 product cases remain `not_run`.

## Verification

- `npm ci`: passed from the pinned lockfile; no lockfile diff.
- Before the focused spec fix, the four new public-classifier regressions all failed: `The previous reply was:\nI resign.`, the same history with `Final Answer: I resign.`, a quoted transcript ending in `I refuse to make a move.`, and a hypothetical answer ending in `I resign.` each returned `resignation`. The prior 56 focused tests still passed.
- After that fix, those four multiline answers return `format-rejection` with `ambiguous-answer`; the policy authorizes a format correction and preserves the illegal-attempt counter for each.
- At the next baseline (`de3c56d`), four added public-classifier regressions for historical, quoted, and hypothetical text followed by `Final Move: I resign.` or `Final Move=I refuse to make a move.` all failed by returning `resignation`; 62 other fixtures passed.
- After the follow-up fix, those four `Final Move` cases return `format-rejection` with `ambiguous-answer`; the policy authorizes a format correction and leaves illegal attempts unchanged. Standalone `Final Answer`, `Final Decision`, and `Final Move` refusals, JSON `resign: true`, and protocol refusal fixtures still classify as resignations.
- At baseline `fdcfe57`, the LF and CRLF trailing-boundary public regressions already passed because `unwrapCodeFence` trims the complete answer before fallback classification. The single-line resignation guard now trims boundary whitespace itself before checking for CR/LF, so a trailing line ending remains eligible while an interior newline still rejects the fallback as ambiguous.
- `npm test -- --run src/model-replies/model-replies.test.ts`: 69 passed after the boundary-whitespace guard update.
- `npx eslint src/model-replies --max-warnings 0`: passed after the boundary-whitespace guard update.
- `npm run typecheck`: passed for the app and node projects after the boundary-whitespace guard update.
- `npm run check`: passed at the original implementation commit `fe0a041`, before this focused fix. Repository ESLint passed, Vitest passed 230 tests across 9 files, app/node typechecks passed, Vite production build passed, and distribution notices were written. It was not repeated for this narrow parser change.
- Build artifacts: `dist/index.html`, `dist/assets/index-Dn1Kj2XK.css`, and `dist/assets/index-CE2xj8Mp.js`.

The separate API handoff is at `D:/projects/kamkmchess/.scratch/implementation-swarm/KHA-36-api.md`. No live provider requests or native-browser/assistive-technology runs were made.
