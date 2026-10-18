# MVP position checks

`runProofSearchPass(query, options)` is the authoritative bounded search entry point. It first calls `tryFastMatingWitness(query)` and returns immediately only if that helper produces a mate witness accepted by `checkProofEvidence`. If the fast pass finds no witness, the existing breadth-first graph search runs with its original checkpoint and closure-certificate behavior.

## Fast witness API

```ts
tryFastMatingWitness(query): Promise<FastMatingWitnessResult | null>
```

The helper is exported from `src/proofs/index.ts`. Its optional second argument can set `timeBudgetMs` and an `AbortSignal`; normal callers can omit it. A non-null result has `status: 'accepted'`, a `mate-witness` evidence object, and the checker-derived conclusion. It checks all legal root moves for immediate mate, then tries short cooperative mating continuations and their suffixes. These include Fool's Mate, Scholar's Mate and checked motifs from knight-development, Italian, Sicilian and queen-pawn positions. Every proposal must replay legally from the actual position and pass the independent checker; no stored FEN grants a conclusion.

If these proposals fail, cooperative search first tries one greedy continuation to depth 24, then diverse beams of width 16 and 64 to depth 12. All stages share the 80,000-candidate limit and 3,000 ms cap. Its score includes attacked squares around the defending king and approximate king escapes. Candidate selection preserves diversity across mating colors, initial moves and tactical states. These heuristics only order discovery. `runProofSearchPass` passes only its remaining time to this helper and discards positive results found after the overall pass deadline. Candidate transitions reuse a mutable `chess.js` position; the independent proof checker replays any proposed line through the authoritative rules. Position-check acceptance is sound, while generic discovery remains heuristic. See [position-check performance](position-check-performance.md) for the allocation fixes, Worker lifecycle and benchmark.

## Second-turn stall

The reported `e4 e5 Nf3` stall reproduced with three committed moves and "Position check pending." The next provider request had not started. The automatic position check could not find a mating witness within its bounded pass, so the exact-adjudication gate correctly retained an unresolved position. Earlier browser coverage used Scholar's Mate and did not exercise normal knight development.

The fix adds reusable checked mating continuations and improves the general search. The exact post-Nf3 position and several other opening positions now have regression coverage through `runProofSearchPass` with a 500 ms budget. Browser coverage plays through four Black model replies in a Ruy Lopez opening and three White model replies in an Italian opening, then verifies that human play is enabled. The proof search never supplies the actual model's move.

Validation passed 454 tests across 40 files with `pnpm exec vitest run --maxWorkers 4`, plus all 13 Chromium scenarios against the production build. ESLint, both TypeScript projects, production compilation and `git diff --check` passed. The initial 40-worker unit run exceeded the existing locked-wall search timeout and the aggregate timeout for three bounded color queries. The color test now allows its three independent 3-second passes; the four-worker run passed the locked-wall test without changing its timeout or production budgets. Provider traffic was intercepted in browser tests; no live model charge was incurred.

## Measured examples

Historical local wall-clock measurements before the performance fixes for checked global-deadness witnesses (the checker conclusion is `not-dead`):

| Position reached by | Result | Elapsed |
| --- | --- | ---: |
| `e4 e5 Nf3 Nc6 Bb5` (Ruy Lopez) | Checked witness, 11 plies | 1,011 ms |
| `d4 d5 c4` | Checked witness, 6 plies | 521 ms |
| `e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Qf3` (middlegame) | Checked witness, 2 plies | 60 ms |

These are representative successful probes, not coverage guarantees. The seeded opening lines remain faster. Under concurrent test load the Ruy Lopez probe has also reached the 3,000 ms cap without a witness. The locked pawn-wall fixture remains pending in the positive pass; it is not classified from the cutoff and proceeds to exhaustive search. Other positions, including positions with mating material and legal moves, can also return `null` and remain pending until the complete search finds a checked witness or a checked closure certificate.

`null` means the quick pass did not produce a checked witness. It never establishes deadness or proves that a color cannot mate. In particular, material counts, legal move counts, heuristic scores, and search cutoffs are not proof evidence. The only fast positive outcome is a concrete legal move sequence independently replayed by `checkProofEvidence`.

The global-deadness query accepts a checked mate witness for either color and concludes `not-dead`. Cooperative reachability accepts only a witness for its `intendedColor`. Timeout mating accepts only the color opposite `expiredColor`. The heuristic only orders candidate lines; it cannot change these query-specific checker rules.

## Complete search and checkpoints

When fast discovery returns `null`, `runProofSearchPass` continues its existing exhaustive successor enumeration. Set `fastWitness: false` in pass options when a caller specifically needs graph traversal and a resumable successor checkpoint. Existing checkpoints are validated before fast discovery. A quick witness can conclude positively while resuming a valid checkpoint, but a malformed or query-mismatched checkpoint still returns `invalid-checkpoint`. Closed successor-set evidence remains the only route to a negative conclusion, and the checker regenerates every legal successor before accepting it.

## MVP behavior

- Ordinary opening positions can return a short checked mating witness before graph expansion, including the standard start, after `e2e4`, and after `e2e4 e7e5`.
- Tactical and middlegame positions may be resolved when the bounded search finds a witness.
- Locked positions and positions whose witness is not found stay pending for the complete search; the quick pass does not infer a classification from a timeout.
- The helper uses hypothetical legal moves only to construct proof candidates. It does not provide or replace a player's game move.
