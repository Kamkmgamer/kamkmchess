# Agent seats and page tools

An agent seat lets a tool-calling agent (Claude in Chrome, a WebMCP-capable browser agent, or any script on the page) play one side of a local game. It sits beside the existing modes: **Human versus agent**, **Agent versus engine** and **Agent versus AI**. Nothing about the six earlier modes changes.

## How it fits

- An agent seat is the v1 automated-player record with the reserved provider ID `page-agent`, the same way browser engines use `browser-uci`. The controller, storage, archives and cloud DTOs need no new seat kind.
- `runAgentTurn` (`src/agents/turn.ts`) mirrors `runGenerationTurn`: it opens a fenced model turn, composes the same compact input with `composeMoveInput`, archives the request, waits for the agent's reply through the `AgentBridge`, and lets `decideCompletedAnswer` and the controller judge it. Illegal-move and formatting budgets, plan memory (`previousThinking`), Undo and Stop behave exactly as they do for an API model.
- The bridge only carries one open turn between the match and a tool call. It never decides legality, clocks or results.
- Agent modes default to 180 minutes plus 60 seconds per move. The clock core is unchanged.
- The agent's name is self-reported (`model_name`), kept per game in local storage and shown as "Name (self-reported)". The archived request records it too.

## Tools

Registered with WebMCP (`document.modelContext.registerTool`, falling back to `navigator.modelContext`) when the browser supports it, and always available as `window.kamkmChessAgent.call(name, input)`.

| Tool | Does |
| --- | --- |
| `get_rules` | Move format, budgets, clocks and the fairness rule (no code, engines or analysis tools). |
| `start_game` | Starts an agent game against Stockfish (think time 100-10,000 ms) or a person at the screen. |
| `join_seat` | Names the agent in a game set up on the page. |
| `get_board` | Status, side, position and, on the agent's turn, the exact input an API model gets. No legal-move list. |
| `make_move` | Plays a coordinate move with an optional plan, then waits up to 60 s for the reply. |
| `wait_for_turn` | Waits up to 120 s for the agent's turn or the end of the game. |
| `resign` | Resigns on the agent's turn. |

Every call returns `{ ok, result }` or `{ ok: false, error }`; WebMCP receives the same object as JSON text.

## Tests

`src/agents/agents.test.ts` runs agent turns on a real controller and store: the compact input, plan carry-over, the four-illegal-move loss and fencing a stopped turn. `tests/e2e/agent-seat.spec.ts` has a scripted agent play Stockfish Lite through `window.kamkmChessAgent`, and checks the new modes, the long clock default and joining a game a person set up.

## Play with your agent

The landing page's **Play with your agent** section (`#agents`, also in the
sidebar) turns this into copy-ready setup. People choose the opponent, the
color and Stockfish's strength, or tick **Let my agent ask me first** so the
agent asks before it starts. Each client gets its own steps:

- **Claude in Chrome** (or any browser agent): one prompt that opens `/play`
  and uses the page tools. Always available.
- **Claude Code, Codex, claude.ai, ChatGPT, Cursor / any MCP**: an install
  command, connector URL or config for the remote endpoint, then the same
  prompt. These appear only when `/v1/online/features` reports `mcp: true`
  (see `docs/implementation/remote-mcp.md`).

The prompts are built in `src/agents/connect.ts`.
