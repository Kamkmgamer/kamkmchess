# Issue tracker

This project uses Linear. The user explicitly selected Linear for the CLIProxyAPI chess MVP wayfinder effort.

The canonical map is [Find the way to the CLIProxyAPI chess MVP](https://linear.app/kamkm/issue/KHA-5/find-the-way-to-the-cliproxyapi-chess-mvp), in the khalil workspace and Khalil team. All nine child issues and all 15 native blocking relationships have been published and read back for verification. Their returned URLs and relationships are recorded in `.scratch/cli-proxy-chess/published-issues.json`.

Linear's official MCP server is configured as `linear` at `https://mcp.linear.app/mcp` and authenticated through Codex OAuth. Prefer its tools when the running session exposes them. Keep credentials in the client's credential store, never in this repository. Files under `.scratch/cli-proxy-chess/` are publication drafts and connection records, not a second canonical tracker.

If a running session lacks native Linear tools, `.scratch/cli-proxy-chess/linear_mcp.py` sends standard MCP calls through Linear's documented `mcp-remote` bridge. It uses the bridge's existing OAuth store. Pass a JSON array of `{name, arguments, key}` tool calls and a result-file path. It stops on a tool error and saves completed results for inspection before any retry. For example, `python .scratch/cli-proxy-chess/linear_mcp.py calls.json results.json`. Keep transient call and result files out of commits. The installed MCP tool catalog can be queried through MCP `tools/list`; do not guess a tool's arguments.

## Wayfinding operations

- The map is one Linear issue labelled `wayfinder:map`.
- In Linear, the `wayfinder` label group contains `map`, `research`, `grilling`, and `prototype`; these correspond to the skill's `wayfinder:<type>` label vocabulary.
- Decision tickets are native child issues of the map, each labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Use Linear's native blocking issue relations. Create all issues before wiring those relations.
- The frontier consists of open, unblocked, unassigned children, ordered by creation order.
- Claim a ticket by assigning it to the developer driving the map before working.
- Record a resolution in a comment, mark the ticket done, and add a named link plus a short gist to the map's Decisions so far.
- Keep open-ticket listings out of the map body. Query the children instead.
- Refer to maps and tickets by linked titles in human-readable text.
- Keep decision detail in its ticket. Link research and prototype assets from that ticket.

