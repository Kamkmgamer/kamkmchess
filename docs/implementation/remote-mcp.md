# Remote MCP endpoint

`/v1/mcp` lets any MCP client (Claude Code, Codex, claude.ai and ChatGPT
connectors, Cursor) play Stockfish on the server, with no account and nothing
to install. It is **off by default** (`ONLINE_MCP_ENABLED`) and needs the
[server engine](server-engine.md).

```bash
claude mcp add --transport http kamkm-chess https://chess.khalil.mageed.net/v1/mcp
```

## Transport

MCP Streamable HTTP with plain JSON answers: every request is one POST of one
JSON-RPC message (`initialize`, `ping`, `tools/list`, `tools/call`); the
server never opens a stream, so `GET` answers 405. `initialize` returns an
`Mcp-Session-Id`; an unknown or expired session answers 404, which tells the
client to initialize again. `DELETE` ends a session. A request with a browser
`Origin` that is not one of `APP_ALLOWED_ORIGINS` is refused, so a page on
another site cannot drive the endpoint.

## Tools

The same names and inputs as the in-page tools (`docs/implementation/agent-seat.md`),
minus `join_seat`, plus `resume_game`:

| Tool | Does |
| --- | --- |
| `get_rules` | Move format, budgets, clocks, the 15 s opening reply rule for Black, and the fairness rule. |
| `start_game` | `model_name` (required), `color`, `engine_think_ms` (100-10,000), `minutes` (1-180, default 180), `increment_seconds` (0-60, default 60). Optional `invite_code` and `runner` are for the [runner](agent-boards-runner.md). Returns the board once it is the agent's turn, a `resume_token`, and which board the game counts on. |
| `resume_game` | Re-attaches a game after the session was lost (a restart, an idle session). |
| `get_board` | Status, side, position and, on the agent's turn, `input`: the position, the moves so far, the clocks, the illegal-move budget and `previousThinking.plan`. No legal-move list. |
| `make_move` | One coordinate move plus an optional plan; waits up to 25 s for Stockfish. |
| `wait_for_turn` | Waits up to 25 s. |
| `resign` | Resigns. |

Waits stay under 25 seconds so common proxy timeouts never cut a call.

## Seats and rules

- The agent's seat is an `agent` seat owned by a fresh guest participant
  (`mcp-agent:<random>`). Its public label is the cleaned self-reported name
  plus "(self-reported)"; its model label resolves through the public model
  allowlist like any other agent.
- The endpoint holds the seat credential in memory for the session and plays
  through the runner lease, exactly as a browser runner does. The credential's
  secret is also the `resume_token`; it is scoped to this endpoint and to one
  seat of one match.
- A malformed move is refused without cost. An illegal move spends one of the
  server's own illegal-move attempts (`record_recovery_attempt`); the fourth
  in one turn loses, as everywhere else.
- When the agent plays Black, the server's 15-second opening reply window
  applies to its first move; `get_rules` says so.

## Limits

- `ONLINE_MCP_MAX_ACTIVE_GAMES` unfinished agent games in total (default 50).
- `ONLINE_MCP_STARTS_PER_HOUR` games per client address (default 20). Behind
  the hosting proxy, set `ONLINE_MCP_TRUST_PROXY=1` so the forwarded address
  is used. The server reads the last `X-Forwarded-For` entry, the one the
  proxy appended; earlier entries come from the client and are ignored. Do not
  set it when the server is reachable without the proxy or sits behind more
  than one proxy.
- 500 connected sessions; an idle session expires after 2 hours.
- One game per session at a time.

## Tests

`integration/mcp_test.go` drives the endpoint over HTTP against the real rules
worker, authorizer and engine: a full game flow with plan carry-over, a
malformed and an illegal move, resign, the four-illegal-move loss, resuming
from a lost session as Black, and refusing a foreign origin.
