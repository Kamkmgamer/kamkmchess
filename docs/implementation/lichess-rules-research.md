# Lichess rules and position checks

Checked 2026-10-18 against first-party source and the npm registry. The owner requested replacing the slow, memory-heavy implementation and accepted Lichess's licensing in this conversation.

## Recommendation

Use **`chessops` 0.15.1** for standard-chess move generation, move validation, FEN and SAN, check detection, mate, stalemate and insufficient material. Remove the exhaustive mating-reachability search from normal play and timeout decisions. Retain the application's repetition ledger, clocks, move history and controller fences. Chessops represents a position rather than an application's game history; its `outcome()` does not implement repetition or move-count draws. See [published package metadata](https://registry.npmjs.org/chessops/0.15.1) and [position implementation](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/chess.ts).

This changes the earlier exact-adjudication requirement in `CONTEXT.md` and `docs/spec/mvp-handoff.md`. Lichess-style insufficient-material rules do not solve every possible dead position. A blocked pawn position can remain playable even when no cooperative mate exists. The new policy should say this plainly and should not retain an exact-search gate under a different name.

## What Lichess actually uses

- The Lichess web frontend depends on unscoped `chessops` `^0.15.1`. Its Learn board calls `Chess.fromSetup`, `chessgroundDests`, `makeSan` and `play`; its editor uses `setupPosition` and FEN helpers. Sources: [root dependencies](https://github.com/lichess-org/lila/blob/41e6990b1be72c93edfbd91a57c54f90d9547fe1/package.json), [Learn rules](https://github.com/lichess-org/lila/blob/41e6990b1be72c93edfbd91a57c54f90d9547fe1/ui/learn/src/chess.ts), [editor](https://github.com/lichess-org/lila/blob/41e6990b1be72c93edfbd91a57c54f90d9547fe1/ui/editor/src/ctrl.ts).
- Its authoritative server uses **scalachess 18.0.0**, a Scala library. The server's timeout finisher calls `position.opponentHasInsufficientMaterial`. This is not a request to a chess engine or an exhaustive mate search. Sources: [server dependency](https://github.com/lichess-org/lila/blob/41e6990b1be72c93edfbd91a57c54f90d9547fe1/project/Dependencies.scala), [timeout finisher](https://github.com/lichess-org/lila/blob/41e6990b1be72c93edfbd91a57c54f90d9547fe1/modules/round/src/main/Finisher.scala).
- The correct npm package is `chessops`, maintained at `niklasf/chessops`. `lichess-org/chessops` redirects there. The npm registry returned 404 for `@lichess-org/chessops`; the scoped naming used by Chessground does not apply. Version 0.15.1 declares `GPL-3.0-or-later` and publication commit `4a4cbd5ac6159adfb236a2616701253ae4c58b2d`. Sources: [registry](https://registry.npmjs.org/chessops/0.15.1), [manifest](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/package.json), [README](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/README.md).

## APIs and integration details

| App responsibility | Chessops API | Detail |
| --- | --- | --- |
| Parse a position | `parseFen`, then `Chess.fromSetup` | Parsing syntax and validating a position are separate operations. |
| Legal moves | `dests`, `allDests`, `isLegal` | Reuse `ctx()` within a calculation. Expand promotion destinations into queen, rook, bishop and knight moves. |
| Apply a move | `play` | Call `isLegal` first. `play` itself does not validate. |
| SAN | `makeSan`, `makeSanAndPlay`, `parseSan` | `makeSan` clones; `makeSanAndPlay` mutates. |
| Chessground destinations | `chessgroundDests` from `chessops/compat` | Supplies both castling representations for Chessground. |
| Check and endings | `isCheck`, `isCheckmate`, `isStalemate`, `outcome` | Apply checkmate before application repetition and halfmove draw rules. |
| Material draw | `isInsufficientMaterial` | Both colors must have insufficient material. |
| Timeout material | `hasInsufficientMaterial(wouldBeWinner)` | Evaluate the opponent of the expired color, not the expired side. |

Sources: [position and castling code](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/chess.ts), [Chessground compatibility](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/compat.ts), [FEN](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/fen.ts), [SAN](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/san.ts).

Keep the strict orthodox FEN wrapper. Chessops accepts shortened FENs and Chess960 castling notation, and normalizes invalid or unusable rights during setup. `toSetup()` strips en passant unless a legal capture exists and clamps the halfmove counter to 150 and fullmove number to 9999. Preserve the app's exact counters and valid recorded en passant target separately when serializing saved positions; use the normalized capturable target for repetition identity. Internally castling destinations are rook squares, so normalize ordinary app coordinates to king destinations `c1`, `g1`, `c8`, `g8` at the adapter boundary. Sources: the FEN, position and compatibility files above.

## Draw and timeout policy

The material tests recognize bare kings, a single minor against a bare king, and bishop-only positions where all bishops use one square color. They do not draw king and two knights against king solely because mate cannot be forced: cooperative mate remains possible. A lone knight can have mating material when the opponent has a pawn, rook or minor piece that can help block the king. A lone bishop can have mating material when opposing pawns, knights or opposite-color bishops permit it. Both chessops and scalachess inspect both sides' material. Sources: [chessops material rules](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/chess.ts), [scalachess material rules](https://github.com/lichess-org/scalachess/blob/afdc6a262d98ea26eafda90ba4c7bf5bf6ac912b/core/src/main/scala/InsufficientMatingMaterial.scala).

Current scalachess adds a bounded **one-ply timeout check**. If the expired side has legal moves and every possible move immediately wins for that side, stalemates, or leaves the opponent with insufficient material, the opponent cannot receive a timeout win. Any move that checkmates for the opponent prevents that shortcut. Mirror this with root legal moves and temporary position clones if matching current Lichess server behavior is desired. Do not use draw-count history in this hypothetical material check. Source: [`Position.opponentHasInsufficientMaterial`](https://github.com/lichess-org/scalachess/blob/afdc6a262d98ea26eafda90ba4c7bf5bf6ac912b/core/src/main/scala/Position.scala).

Chessops uses fixed-size board bitboards and checks the current position directly. Its material classification has no search tree, checkpoint or asynchronous pending result. Removing this app's reachability graph and worker gate eliminates that source of retained state and waiting. This is an architectural conclusion, not a measured memory benchmark or proof that all current memory growth is a leak. Source: [board representation](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/board.ts), [square sets](https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/squareSet.ts), position code above.

## Implemented replacement and measurements

Interactive controllers now default to `positionChecks: 'lichess'`. The match composition no longer creates an analysis runner or proof-search store, and the UI no longer imports search code or offers a position-check action. Checkmate, stalemate, material, repetition and halfmove checks settle in the accepted move transaction. Timeout decisions include the bounded one-ply check described above. Old pending saves are classified on restore, their obsolete proof candidates and search checkpoints are removed, and the migration is persisted under the existing revision/ownership fence. Previously final legacy outcomes remain final. The explicit `legacy-proof` controller policy and offline proof modules retain archive/fixture compatibility.

Rules adapters cache only against immutable position objects in WeakMaps. Engine clones isolate mutation. SAN generation no longer enumerates and formats every legal move. Undo retains one full baseline and compact prior turn metadata; earlier baselines are rebuilt from existing move/history ledgers instead of recursively retaining complete checkpoint copies. Repeated local and AI takebacks, including after reload, remain available.

Measured on the local Windows/Node 24 environment:

| Position | Previous proof-search median | Direct rules median |
| --- | ---: | ---: |
| Start | 3.8 ms | 0.365 ms |
| Ruy Lopez, move 3 | 8.0 ms | 0.182 ms |
| Ruy Lopez, move 15 | 13.4 ms | 0.192 ms |
| Sicilian, move 15 | 108.8 ms | 0.133 ms |
| Nimzo-Indian, move 15 | 17.6 ms | 0.078 ms |

These compare the former exhaustive non-deadness proof with its replacement policy, not identical algorithms. The direct benchmark includes fresh strict FEN parsing, repetition identity, ending/material facts and legal move generation. It uses 100 warmed samples per position; the old benchmark used seven warmed samples. Cold startup and machine load vary. Run `pnpm benchmark:position-check --max-ms=5` to repeat the new benchmark.

`node --expose-gc scripts/benchmark-position-check.mjs --max-ms=5 --memory` also checks retained rules memory. After a 5,000-check warmup, the process heap was 14.62 MiB; after five additional 5,000-check batches and explicit GC it was 14.62, 14.63, 14.67, 14.67 and 14.67 MiB. This checks the rules path's retained heap; it does not establish a bound on the entire browser app or stored conversation history. Browser fixtures verify thirty plies against an offline AI with zero proof workers, plus the existing board interactions, premoves and history navigation.
