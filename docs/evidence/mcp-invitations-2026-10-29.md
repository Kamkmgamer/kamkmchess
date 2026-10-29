# MCP invitations rollout, 2026-10-29

Deployed to https://chess.khalil.mageed.net. Frontend deployment:
`dpl_BWW4VzTGmUxmEmNNzF6G5QaLpX83`.

The API runs the tested `kamkmchess-api:mcp-20261029` image with native
Stockfish. `ONLINE_MCP_ENABLED` and `ONLINE_SERVER_ENGINE_ENABLED` are enabled.
The deployment's Compose `.env` sets `WITH_SERVER_ENGINE=1` for future builds.
The API restart used the planned suspension boundary; service epoch 3 resumed
with the durable gate open. Configuration and image rollback copies remain
in the private server deployment directory.

Verification completed:

- 126 frontend unit test files, 1,610 tests passed.
- Type checking, ESLint, production build and UI design detector passed.
- Desktop 1280px and mobile 390px screenshots had no horizontal overflow or
  browser errors.
- Seven MCP integration tests passed against an isolated PostgreSQL container,
  the real rules worker, seat authorizer and native Stockfish. This includes
  shared invitations, refusing a move before both players join, separate side
  control, credential-free spectator responses, delayed Stockfish opening,
  move history, illegal-move loss, reconnects and denied origins.
- Three Playwright tests passed for MCP discovery, separate White and Black
  prompts, spectator links and a human joining the opposite side.
- Twenty-one runtime grant and provisioning tests passed.
- Public-endpoint smoke tests passed for shared games and delayed Stockfish.
- A production browser created an Agent-versus-Agent match through the live
  settings, obtained both invitations, and watched MCP clients join, play
  `e2e4`, and resign. The viewer displayed the final resignation result with
  no browser errors. The test games were ended.

The rollout exposed a missing UPDATE grant on `online_profile_result_totals`.
Result publication uses `ON CONFLICT DO UPDATE`. The runtime policy now grants
that operation explicitly, and the grant was applied to production. Subsequent
logs had no result-publication permission errors.

The local in-page bridge remains an internal legacy implementation. The
deployed game publishes only `connect_chess_mcp` through page-tool discovery.
New invitations and generated prompts use the remote MCP endpoint.

An external agent starts playing after its human gives it the prompt and it
connects. Selecting Agent on the website cannot launch another application's
model. Human play on the shared board currently promotes pawns to queens.
Both players must reconnect their MCP sessions after an API restart. Setup
games and shared games do not publish placeholder model names to leaderboards.
