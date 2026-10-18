# Lichess evaluation bar research

Checked 2026-10-18 against the current `lichess-org/lila` source.

Lichess publishes its client evaluation code in [lila's ceval directory](https://github.com/lichess-org/lila/tree/master/ui/lib/src/ceval). This includes browser engine adapters, UCI handling, evaluation controls, and the gauge. The gauge is part of the Lichess application rather than a standalone React component. It depends on the surrounding controller, Snabbdom view helpers, global types and styles.

Relevant primary sources:

- [Gauge rendering](https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/view/main.ts), `renderGauge`, uses White's score and reverses the gauge for Black's orientation.
- [Gauge styles](https://github.com/lichess-org/lila/blob/master/ui/lib/css/ceval/_eval-gauge.scss) render black and white regions, a midpoint, and an animated evaluation boundary.
- [Winning chances](https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/winningChances.ts) maps centipawns through a sigmoid with coefficient 0.00368208, clamping centipawns to plus or minus 1000.
- [Engine protocol](https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/protocol.ts) handles engine output.
- [Copying terms](https://github.com/lichess-org/lila/blob/master/COPYING.md) license the application code under AGPL-3.0-or-later, except listed assets and files.

The app already uses Lichess's separate Chessground and chessops packages. Neither package supplies an evaluation bar. Importing lila's full client evaluator would also duplicate the existing pinned Stockfish.js download cache and worker integration.

The implementation therefore adds a small React bar and an independent UCI evaluation path to the existing engine module. No lila component or stylesheet is copied or added as a dependency. The numeric mapping uses the same published centipawn scale, expressed with a hyperbolic tangent. Mate scores fill the winning color's bar; mate zero explicitly means the root side to move is checkmated. Scores always use White's perspective, including when Black starts a custom position.

This requires no new engine package. `stockfish@19.0.1` already supplies the full and Lite single-threaded builds. Analysis selects the full build only when downloaded and uses Lite otherwise. No Lichess API calls or hosted analysis service are involved.
