# Server engine seat

The server can play its own Stockfish in online matches. It is **off by
default** (`ONLINE_SERVER_ENGINE_ENABLED`), and turning it on opens no new
surface by itself: the seat only plays in matches that were created against it
(the remote MCP endpoint is the first caller).

## How it plays

- The seat is an ordinary `engine` seat owned by a guest participant whose
  identifier starts with `server-engine:`. The think time is part of the
  identifier (`server-engine:<ms>:<random>`), so a restarted server plays the
  seat at the same strength without another table.
- `backend/serverengine` sweeps every `ONLINE_SERVER_ENGINE_SWEEP_INTERVAL`
  for server seats that are to move. For each it reads the match, takes the
  seat's runner lease for the current turn, asks the engine for a move and
  submits `submit_move` with the lease, as the seat's own guest participant.
  The online writer still checks legality, clocks, fencing and results; the
  server engine has no authority a browser engine lacks.
- The seat credential lives only in memory. After a restart the next turn
  rotates it, which supersedes the lost secret.
- The engine never spends more than a thirtieth of its remaining clock on a
  move, and never more than 10 seconds.

## Engine pool

`backend/engine` keeps `ONLINE_SERVER_ENGINE_SLOTS` native UCI processes. A
search borrows one, sends `ucinewgame`, the position and `go movetime`, and
returns it. A process that fails is killed and replaced on the next search.
One process starts at boot, so a missing or broken executable stops the boot
instead of failing the first game.

## Label

Migration 0026 resolves the public label of a server seat to
`Stockfish (server)`. Browser engine seats keep `Stockfish 19 Lite (browser)`.

## Deploying

Build the API image with `--build-arg WITH_SERVER_ENGINE=1` to include
`/usr/bin/stockfish` (Stockfish 19 from Alpine edge), then set
`ONLINE_SERVER_ENGINE_ENABLED=1` and `ONLINE_SERVER_ENGINE_PATH=/usr/bin/stockfish`.

## Tests

`backend/engine` tests a mate in one, concurrent searches, a killed process
and cancellation. `integration/server_engine_test.go` plays the engine against
itself and against a person through the real rules worker and authorizer, and
checks that a restarted driver recovers its credential. They need
`KAMKM_ENGINE_PATH` (and skip without it), like the PostgreSQL tests need
`KHA41_TEST_DATABASE_URL`.
