-- KHA-41 version 1. Owner is the verified Clerk subject (opaque text).
CREATE TABLE IF NOT EXISTS games (
  game_id text PRIMARY KEY,
  owner_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  ownership_epoch bigint NOT NULL CHECK (ownership_epoch >= 1),
  checkpoint_json bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS games_owner_updated ON games(owner_id, updated_at DESC, game_id);
CREATE TABLE IF NOT EXISTS archive_chunks (
  game_id text NOT NULL REFERENCES games(game_id),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  item_id text NOT NULL,
  raw_json bytea NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (game_id, sequence), UNIQUE(game_id,item_id)
);
CREATE TABLE IF NOT EXISTS archive_events (
  game_id text NOT NULL REFERENCES games(game_id),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  item_id text NOT NULL,
  raw_json bytea NOT NULL,
  PRIMARY KEY (game_id, sequence), UNIQUE(game_id,item_id)
);
CREATE TABLE IF NOT EXISTS operations (
  owner_id text NOT NULL,
  game_id text NOT NULL REFERENCES games(game_id),
  operation_id text NOT NULL,
  request_hash bytea NOT NULL,
  revision bigint NOT NULL,
  ownership_epoch bigint NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  result_json bytea NOT NULL,
  PRIMARY KEY (owner_id, game_id, operation_id)
);
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  game_id text PRIMARY KEY,
  owner_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  last_revision bigint NOT NULL,
  last_epoch bigint NOT NULL
);
