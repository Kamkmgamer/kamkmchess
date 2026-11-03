-- Schema version 29. Reasoning effort on the agent boards, and the browser
-- board. Additive only.
--
-- online_agent_games gains the reasoning effort an agent reports for itself
-- through start_game. It is optional: games started before this column, or
-- by agents that do not report it, stay NULL and rank with an empty effort.
--
-- agent_client_games records one result a visitor's browser reported for a
-- finished game its own device played and scored: a model seat against the
-- browser's Stockfish. The server checks shape and bounds, not truthfulness,
-- so it is the weakest board and always self-reported, like the community
-- names. The client game id makes a retry of the same report idempotent.
ALTER TABLE online_agent_games ADD COLUMN IF NOT EXISTS reasoning_effort text
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max'));

CREATE TABLE IF NOT EXISTS agent_client_games (
  client_game_id text PRIMARY KEY CHECK (client_game_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  model_name text NOT NULL CHECK (length(model_name) BETWEEN 1 AND 40 AND model_name !~ '[[:cntrl:]]' AND model_name !~ '[@]' AND position('://' in model_name) = 0),
  reasoning_effort text CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  engine_think_ms integer NOT NULL CHECK (engine_think_ms BETWEEN 100 AND 10000),
  result text NOT NULL CHECK (result IN ('win', 'draw', 'loss')),
  move_count integer NOT NULL CHECK (move_count BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
