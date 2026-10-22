-- KHA-78 public online history and public replay storage. Additive only.
--
-- This migration adds the storage that publishes completed online friend,
-- queue and fallback games. Nothing here alters the shared match state of
-- migration 0002, and nothing here stores a credential, a provider request, a
-- model conversation, a private endpoint, or an owner archive.
--
-- The declared model label is resolved to a public label before it is stored.
-- A declared label is published verbatim only when the service knows it as a
-- public model name, or when the owner registered it as their own chosen
-- public label. Every other value is a private routing identity, a
-- secret-bearing alias, or a connection nickname, and it is replaced by a
-- neutral public label before it reaches a shared table. The resolution runs
-- on write, so a private identifier never enters the match log, a receipt, or
-- a public projection in the first place.
--
-- Three kinds of rows are added.
--
-- The control timeline records which declared control was in effect for a
-- seat at a match version. It is filled by triggers, so the timeline stays
-- truthful without the match writer changing anything: a later control change
-- never relabels an earlier accepted move.
--
-- The public replay is the allowlisted projection of a completed match. It
-- carries the starting position, the accepted moves, the time control, the
-- result, the public participants and the declared control metadata, and
-- nothing else.
--
-- The profile result rows and the aggregate totals count one account and game
-- result once. The totals survive an explicit removal, so the opponent keeps
-- the anonymous result aggregate of a game whose replay was erased.

-- The public model names a declared label may be published as.
--
-- A name that is not here is a private routing identity until its owner
-- chooses a public label for it.
CREATE TABLE IF NOT EXISTS online_public_model_allowlist (
  model_key text PRIMARY KEY CHECK (model_key ~ '^[a-z0-9][a-z0-9._:/-]{1,63}$'),
  public_label text NOT NULL CHECK (length(public_label) BETWEEN 1 AND 64 AND public_label !~ '[[:cntrl:]]' AND public_label !~ '[@]' AND position('://' in public_label) = 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The public labels an owner chose for their own model opponents.
--
-- The label is registered on its own. The mapping from a private routing
-- identity to that label stays in the owner's browser: the service never
-- receives a routing identifier, an endpoint, a connection nickname, or a
-- credential. Only the registered label can reach a public payload.
CREATE TABLE IF NOT EXISTS online_account_public_labels (
  label_id text PRIMARY KEY CHECK (label_id ~ '^kl_[A-Za-z0-9_-]{8,63}$'),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  public_label text NOT NULL CHECK (length(public_label) BETWEEN 1 AND 64 AND public_label !~ '[[:cntrl:]]' AND public_label !~ '[@]' AND position('://' in public_label) = 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (account_id, public_label)
);
CREATE INDEX IF NOT EXISTS online_account_public_labels_account ON online_account_public_labels(account_id, revoked_at);

-- The known public model names. The list is small and explicit: a name that is
-- not here is a private routing identity until its owner chooses a public
-- label for it.
INSERT INTO online_public_model_allowlist(model_key, public_label) VALUES
  ('gpt-4o', 'GPT-4o'),
  ('gpt-4o-mini', 'GPT-4o mini'),
  ('gpt-4.1', 'GPT-4.1'),
  ('gpt-4.1-mini', 'GPT-4.1 mini'),
  ('gpt-5', 'GPT-5'),
  ('gpt-5-mini', 'GPT-5 mini'),
  ('claude-3-5-sonnet', 'Claude 3.5 Sonnet'),
  ('claude-3-5-haiku', 'Claude 3.5 Haiku'),
  ('claude-3-7-sonnet', 'Claude 3.7 Sonnet'),
  ('claude-sonnet-4', 'Claude Sonnet 4'),
  ('claude-opus-4', 'Claude Opus 4'),
  ('gemini-1.5-pro', 'Gemini 1.5 Pro'),
  ('gemini-1.5-flash', 'Gemini 1.5 Flash'),
  ('gemini-2.0-flash', 'Gemini 2.0 Flash'),
  ('grok-2', 'Grok 2'),
  ('grok-2-latest', 'Grok 2 latest'),
  ('kimi-k2', 'Kimi K2'),
  ('llama-3.3-70b', 'Llama 3.3 70B'),
  ('deepseek-r1', 'DeepSeek R1'),
  ('qwen3-235b', 'Qwen3 235B'),
  ('stockfish-19-lite', 'Stockfish 19 Lite (browser)')
ON CONFLICT (model_key) DO NOTHING;

-- The neutral label a declared control falls back to.
--
-- It states that a model was in control without naming a private routing
-- identity. It is a fixed point of the resolution, so a resolved value is
-- never resolved a second time into something else.
CREATE OR REPLACE FUNCTION online_neutral_model_label() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'Custom model'
$$;

-- Resolves a declared model label to the label that may be published.
--
-- The resolution is idempotent: an already resolved label resolves to itself.
-- A human control has no model label. The browser Stockfish engine is named
-- by the product, not by the owner. A model opponent is named by the
-- allowlisted public model name, or by the public label the owner registered
-- for their own account, and by nothing else.
CREATE OR REPLACE FUNCTION online_resolve_public_model_label(p_owner_kind text, p_owner_id text, p_control_kind text, p_model_label text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  resolved text;
BEGIN
  IF p_control_kind = 'human' THEN
    RETURN NULL;
  END IF;
  IF p_model_label IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_control_kind = 'engine' THEN
    RETURN 'Stockfish 19 Lite (browser)';
  END IF;
  SELECT a.public_label INTO resolved
    FROM online_public_model_allowlist a
    WHERE a.model_key = lower(btrim(p_model_label)) OR a.public_label = p_model_label
    LIMIT 1;
  IF resolved IS NOT NULL THEN
    RETURN resolved;
  END IF;
  IF p_owner_kind = 'account' AND p_owner_id IS NOT NULL AND p_owner_id <> 'anonymized' THEN
    SELECT l.public_label INTO resolved
      FROM online_account_public_labels l
      WHERE l.account_id = p_owner_id AND l.public_label = p_model_label AND l.revoked_at IS NULL
      LIMIT 1;
    IF resolved IS NOT NULL THEN
      RETURN resolved;
    END IF;
  END IF;
  RETURN online_neutral_model_label();
END
$$;

-- The seat stores the publishable label, never the declared private one.
CREATE OR REPLACE FUNCTION online_normalize_seat_model_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.model_label := online_resolve_public_model_label(NEW.owner_kind, NEW.owner_id, NEW.control_kind, NEW.model_label);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_seats_label_normalize ON online_seats;
CREATE TRIGGER online_seats_label_normalize BEFORE INSERT OR UPDATE ON online_seats
  FOR EACH ROW EXECUTE FUNCTION online_normalize_seat_model_label();

-- The accepted event log stores the publishable label too.
CREATE OR REPLACE FUNCTION online_normalize_event_model_label() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_owner_kind text;
  seat_owner_id text;
BEGIN
  IF NEW.event_kind <> 'control_change' OR NEW.control_model_label IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.owner_kind, s.owner_id INTO seat_owner_kind, seat_owner_id
    FROM online_seats s
    WHERE s.match_id = NEW.match_id AND s.seat = NEW.seat;
  NEW.control_model_label := online_resolve_public_model_label(seat_owner_kind, seat_owner_id, NEW.control_kind, NEW.control_model_label);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_events_label_normalize ON online_events;
CREATE TRIGGER online_events_label_normalize BEFORE INSERT ON online_events
  FOR EACH ROW EXECUTE FUNCTION online_normalize_event_model_label();

-- A stored receipt carries the event it accepted. The receipt is written with
-- the declared label of the accepted command, so the receipt is normalized the
-- same way: a private routing identity never reaches the stored receipt.
CREATE OR REPLACE FUNCTION online_normalize_receipt_model_label() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  raw_label text;
  control_kind text;
  resolved text;
  seat_owner_kind text;
  seat_owner_id text;
  seat_name text;
  receipt_json jsonb;
  updated jsonb;
BEGIN
  IF NEW.scope_kind <> 'match' THEN
    RETURN NEW;
  END IF;
  receipt_json := convert_from(NEW.result_json, 'UTF8')::jsonb;
  raw_label := receipt_json #>> '{event,control,modelLabel}';
  IF raw_label IS NULL THEN
    RETURN NEW;
  END IF;
  control_kind := coalesce(receipt_json #>> '{event,control,kind}', 'agent');
  seat_name := receipt_json #>> '{event,seat}';
  SELECT s.owner_kind, s.owner_id INTO seat_owner_kind, seat_owner_id
    FROM online_seats s
    WHERE s.match_id = NEW.scope_id AND s.seat = seat_name;
  resolved := online_resolve_public_model_label(seat_owner_kind, seat_owner_id, control_kind, raw_label);
  IF resolved IS DISTINCT FROM raw_label THEN
    -- The exact path is replaced, so a value that happens to occur elsewhere
    -- in the receipt is never rewritten.
    updated := jsonb_set(receipt_json, '{event,control,modelLabel}', to_jsonb(resolved), false);
    NEW.result_json := convert_to(updated::text, 'UTF8');
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_receipts_label_normalize ON online_operation_receipts;
CREATE TRIGGER online_receipts_label_normalize BEFORE INSERT ON online_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION online_normalize_receipt_model_label();

-- The declared control timeline of one seat.
--
-- A row is written when the seat is created and again whenever the seat's
-- control changes. The version is the match version the control took effect
-- at, so the control of an accepted move is the newest row of that seat whose
-- version is not greater than the move's version.
CREATE TABLE IF NOT EXISTS online_seat_control_timeline (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  version bigint NOT NULL CHECK (version >= 1),
  control_kind text NOT NULL CHECK (control_kind IN ('human', 'agent', 'engine')),
  -- The publishable label of the control. It is a declaration, never a
  -- verified provider identity.
  model_label text CHECK (model_label IS NULL OR (length(model_label) BETWEEN 1 AND 64 AND model_label !~ '[[:cntrl:]]' AND model_label !~ '[@]' AND position('://' in model_label) = 0)),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, seat, version),
  CHECK ((control_kind = 'human') = (model_label IS NULL))
);
CREATE INDEX IF NOT EXISTS online_seat_control_timeline_match ON online_seat_control_timeline(match_id, seat, version);

-- The initial control of a seat is the control the seat row was created with.
CREATE OR REPLACE FUNCTION online_record_initial_control() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  match_version bigint;
BEGIN
  SELECT version INTO match_version FROM online_matches WHERE match_id = NEW.match_id;
  IF match_version IS NULL THEN
    match_version := 1;
  END IF;
  INSERT INTO online_seat_control_timeline(match_id,seat,version,control_kind,model_label,control_epoch,recorded_at)
    VALUES (NEW.match_id, NEW.seat, match_version, NEW.control_kind, NEW.model_label, NEW.control_epoch, clock_timestamp())
    ON CONFLICT (match_id, seat, version) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_seats_control_timeline ON online_seats;
CREATE TRIGGER online_seats_control_timeline AFTER INSERT ON online_seats
  FOR EACH ROW EXECUTE FUNCTION online_record_initial_control();

-- A control change is journalled with the match version it took effect at.
CREATE OR REPLACE FUNCTION online_record_control_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_kind <> 'control_change' THEN
    RETURN NEW;
  END IF;
  INSERT INTO online_seat_control_timeline(match_id,seat,version,control_kind,model_label,control_epoch,recorded_at)
    VALUES (NEW.match_id, NEW.seat, NEW.version, NEW.control_kind, NEW.control_model_label, NEW.control_epoch, clock_timestamp())
    ON CONFLICT (match_id, seat, version) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_events_control_timeline ON online_events;
CREATE TRIGGER online_events_control_timeline AFTER INSERT ON online_events
  FOR EACH ROW EXECUTE FUNCTION online_record_control_change();

-- The public replay of a completed match.
CREATE TABLE IF NOT EXISTS online_public_replays (
  match_id text PRIMARY KEY REFERENCES online_matches(match_id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version = 2),
  replay_json jsonb NOT NULL CHECK (jsonb_typeof(replay_json) = 'object'),
  -- The hash of the stored result. A replay whose payload does not match its
  -- result hash is refused instead of being served.
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  game_kind text NOT NULL CHECK (game_kind IN ('friend', 'queue', 'fallback')),
  -- An abort is published as an unscored game.
  scored boolean NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revocation_marker_id text,
  CHECK ((revoked_at IS NULL) = (revocation_marker_id IS NULL))
);
CREATE INDEX IF NOT EXISTS online_public_replays_kind ON online_public_replays(game_kind, published_at DESC);

-- The published payload is immutable apart from a recorded anonymization and a
-- recorded removal, exactly like the KHA-65 projection.
CREATE OR REPLACE FUNCTION online_guard_public_replay_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'online public replay removal is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.published_at <> OLD.published_at OR NEW.result_hash <> OLD.result_hash
     OR NEW.schema_version <> OLD.schema_version OR NEW.game_kind <> OLD.game_kind
     OR NEW.scored <> OLD.scored THEN
    RAISE EXCEPTION 'online public replay identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND (NEW.replay_json <> '{}'::jsonb OR NEW.revocation_marker_id IS NULL) THEN
    RAISE EXCEPTION 'online public replay removal must clear its payload' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NULL AND NEW.replay_json IS DISTINCT FROM OLD.replay_json THEN
    -- The only payload rewrite is public-label anonymization, and it must
    -- follow a recorded account or guest anonymization marker for this match.
    IF NOT EXISTS (
      SELECT 1 FROM online_deletion_markers
      WHERE match_id = OLD.match_id AND marker_kind = 'account_anonymization'
    ) THEN
      RAISE EXCEPTION 'online public replay payload is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_public_replays_guard ON online_public_replays;
CREATE TRIGGER online_public_replays_guard BEFORE UPDATE ON online_public_replays
  FOR EACH ROW EXECUTE FUNCTION online_guard_public_replay_update();

DROP TRIGGER IF EXISTS online_public_replays_immutable_delete ON online_public_replays;
CREATE TRIGGER online_public_replays_immutable_delete BEFORE DELETE ON online_public_replays
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- One row per account and game. The primary key is what makes a result count
-- exactly once, however often the projection runs.
CREATE TABLE IF NOT EXISTS online_profile_results (
  profile_id text NOT NULL REFERENCES online_public_profiles(profile_id) ON DELETE CASCADE,
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  outcome text NOT NULL CHECK (outcome IN ('win', 'draw', 'loss', 'abort')),
  scored boolean NOT NULL,
  game_kind text NOT NULL CHECK (game_kind IN ('friend', 'queue', 'fallback')),
  opponent_label text NOT NULL CHECK (length(opponent_label) BETWEEN 1 AND 64 AND opponent_label !~ '[[:cntrl:]]'),
  opponent_profile_id text REFERENCES online_public_profiles(profile_id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (profile_id, match_id)
);
CREATE INDEX IF NOT EXISTS online_profile_results_recent ON online_profile_results(profile_id, completed_at DESC);

-- The aggregate result totals of one profile.
--
-- The totals are kept apart from the per-game rows on purpose. An explicit
-- removal deletes the shared game from both histories, and the opponent keeps
-- the anonymous aggregate of that result.
CREATE TABLE IF NOT EXISTS online_profile_result_totals (
  profile_id text PRIMARY KEY REFERENCES online_public_profiles(profile_id) ON DELETE CASCADE,
  wins bigint NOT NULL DEFAULT 0 CHECK (wins >= 0),
  draws bigint NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses bigint NOT NULL DEFAULT 0 CHECK (losses >= 0),
  aborts bigint NOT NULL DEFAULT 0 CHECK (aborts >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Runtime grants follow the KHA-65 pattern: the API role gets the new tables,
-- the private rules process keeps no table privileges at all.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_public_model_allowlist TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_account_public_labels TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_seat_control_timeline TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_public_replays TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_profile_results TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_profile_result_totals TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_public_model_allowlist FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_account_public_labels FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_seat_control_timeline FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_public_replays FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_profile_results FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_profile_result_totals FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_public_model_allowlist FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_account_public_labels FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_seat_control_timeline FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_public_replays FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_profile_results FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_profile_result_totals FROM PUBLIC;
