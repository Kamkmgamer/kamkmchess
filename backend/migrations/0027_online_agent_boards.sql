-- Schema version 27. Remote agent games and the agent boards. Additive only.
--
-- online_agent_games records one row per game an agent started through the
-- remote MCP endpoint: the self-reported model name, Stockfish's think time
-- and whether the game is verified. A game is verified only when it was
-- started with an invite code an operator issued for the official runner;
-- every other game belongs to the community board. The runner name is
-- metadata the client reports and is never trusted.
--
-- online_agent_invites stores only the hash of an invite code.
CREATE TABLE IF NOT EXISTS online_agent_invites (
  invite_id text PRIMARY KEY CHECK (invite_id ~ '^inv_[a-f0-9]{16}$'),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]'),
  uses_left integer NOT NULL CHECK (uses_left >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS online_agent_games (
  match_id text PRIMARY KEY REFERENCES online_matches(match_id) ON DELETE CASCADE,
  agent_seat text NOT NULL CHECK (agent_seat IN ('white', 'black')),
  model_name text NOT NULL CHECK (length(model_name) BETWEEN 1 AND 40 AND model_name !~ '[[:cntrl:]]' AND model_name !~ '[@]' AND position('://' in model_name) = 0),
  engine_think_ms integer NOT NULL CHECK (engine_think_ms BETWEEN 100 AND 10000),
  verified boolean NOT NULL DEFAULT false,
  invite_id text REFERENCES online_agent_invites(invite_id) ON DELETE SET NULL,
  runner text CHECK (runner IS NULL OR (length(runner) BETWEEN 1 AND 40 AND runner !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT verified OR invite_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS online_agent_games_board ON online_agent_games(verified, model_name);
