# Position-check performance

The position check proves that a legal continuation can reach checkmate, even if both sides cooperate. It is more expensive than checking whether a king is currently in check. A search cutoff cannot establish deadness. Every successful discovery still passes the independent proof checker.

## Cause and changes

A Ruy Lopez position after 15 full moves reproduced a 1,935 ms pause in the initial isolated test. Instrumentation found 3,553 board loads and thousands of notation builds in one check. The search constructed a new `Chess` for every candidate, generated verbose moves with SAN and before/after FENs, allocated board snapshots repeatedly during scoring, and copied the full path for every child. Independent replay also generated verbose moves for every piece before selecting the submitted move. Each completed check then terminated its Worker, losing loaded modules and optimized code before the next turn.

The changes remove those repeated costs:

- Discovery makes and unmakes legal move records on one board. It serializes only beam parents, uses position hashes to prune repeated candidates, and reconstructs a path only when it finds a mate.
- Scoring reads the numeric board and king locations without allocating board snapshots. King-zone attack counts are reused for diversity selection.
- A greedy pass to depth 24 precedes the diverse search. Width 64 is a final positive-only fallback for positions missed by width 16, including the Ruy Lopez after `6...b5`. The deeper greedy pass also resolves the position after `8...O-O` without exhaustive expansion.
- Seed moves are parsed once, impossible first moves are skipped, and seed replay observes the pass deadline and cancellation signal.
- The search yields according to elapsed time, at intervals of about 8 ms, rather than after fixed numbers of nodes and levels.
- Independent transitions generate verbose candidates only for the submitted source square. They continue to validate moves through the public rules API.
- The runner retains at most one successful idle Worker. Stop, errors and non-results terminate their Worker; closing the runner also terminates its idle Worker. Query and request fences still apply to every reply.

`chess-search.ts` deliberately confines access to internals of the pinned `chess.js` 1.4.0 dependency. It is only a discovery adapter. Upgrading the dependency requires running its public-API comparison and perft tests. Hash collisions can discard a discovery candidate but cannot accept evidence. The checker uses the authoritative rules and regenerates every submitted transition.

## Local measurements

On Node 24.22.0, the same benchmark with baseline search/transition sources from commit `3ad3136` gave these warmed medians before and after the changes:

- Standard start: 12.2 ms to 5.2 ms.
- Ruy Lopez after `3.Bb5`: 28.5 ms to 9.9 ms.
- Ruy Lopez after 15 full moves: 1,131.4 ms to 12.3 ms.
- Sicilian after 15 full moves: 847.8 ms to 95.7 ms.
- Nimzo-Indian after 15 full moves: 853.7 ms to 15.6 ms.

The first measured Ruy Lopez move-15 pass improved from 1,187.8 ms to 20.9 ms. The benchmark uses the actual positions and independently checked witnesses on every run; it does not cache conclusions. These examples are performance measurements, not a guarantee for arbitrary positions.

## Reproduction and verification

Run `pnpm benchmark:position-check` for isolated wall-clock measurements. It builds the real proof entry point, checks five fixed opening/middlegame positions, and prints the first run and the median/range of seven subsequent runs. Each run must produce an accepted `not-dead` result. `pnpm benchmark:position-check --max-ms=200` additionally fails if any warmed median exceeds 200 ms. Run it without other CPU-heavy checks for comparable timings. These measurements include proof replay in `runProofSearchPass`; they exclude Worker startup, storage, provider requests and rendering.

The unit regression tests bound board loads and notation builds rather than asserting wall-clock times under concurrent CI load. Additional tests compare legal moves, transitions, hashes, board access and attacks against the pinned public chess.js API for castling, en passant, pinned en passant, captures and underpromotions. Nested make/unmake reproduces the standard 20, 400 and 8,902 perft counts.

The browser regression plays a complete 15-move Ruy Lopez with offline model replies and asserts that one proof Worker serves the whole game. The suite also covers reuse across query identities, stale replies, cancellation, errors and closing an idle Worker.

Validation passed 473 tests across 42 files with `pnpm exec vitest run --maxWorkers 4`, all 14 production-build Chromium scenarios, ESLint, both TypeScript projects, the production build and `git diff --check`. Provider traffic was intercepted in browser tests.

Exact mating reachability remains a bounded search. Difficult positions can take longer or remain pending, and the changes do not replace proof evidence with material counts or a timeout verdict.
