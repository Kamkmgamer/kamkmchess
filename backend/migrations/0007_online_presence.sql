-- KHA-70 schema version 7. Online presence, the liveness lease and the
-- optional abandonment claim.
--
-- Additive only. Nothing in this file alters, rewrites, or re-grants the
-- private single-owner sync tables from 0001_storage.sql, and no existing
-- shared row is rewritten. The online tables keep no foreign keys into the
-- private archive and never store provider credentials, raw provider
-- requests, AI conversation, private endpoints, or owner archives.
--
-- Go is the only transaction writer. The kamkm_online_rules runtime role keeps
-- schema USAGE and no table privileges, so the private rules process cannot
-- read or write canonical online state.
--
-- Presence is a liveness record, not an account. It holds the participant
-- reference that owns the seat, the last application heartbeat, and the
-- liveness lease that heartbeat bought. It never holds a credential, a token,
-- a session identifier, a provider route, or a conversation.

-- The presence of one seat of one match.
--
-- last_heartbeat_at is the moment the participant's application reported in.
-- lease_expires_at is the end of the liveness lease that heartbeat bought, so
-- a suspended client stays connected only while its lease lasts. The instant
-- the lease expires is the moment the participant counts as offline, so a
-- fresh heartbeat starts a fresh offline interval.
--
-- The row is keyed by the seat, so a seat has exactly one presence record and
-- a second tab of the same owner updates that record instead of creating a
-- second one.
--
-- The keep-waiting marker belongs to the offline interval it was recorded in.
-- A fresh heartbeat clears it, because the participant is connected again and
-- the marker no longer describes anything.
CREATE TABLE IF NOT EXISTS online_presence (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  owner_kind text NOT NULL CHECK (owner_kind IN ('account', 'guest')),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  last_heartbeat_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  keep_waiting_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, seat),
  CHECK (lease_expires_at > last_heartbeat_at)
);
CREATE INDEX IF NOT EXISTS online_presence_lease ON online_presence(lease_expires_at);

-- The claim ends the match with an abandonment win, so the event kind joins
-- the kinds that may carry a result.
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_event_kind_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_event_kind_check CHECK (event_kind IN ('match_created', 'move', 'resign', 'abort', 'cancel', 'control_change', 'timeout', 'replay_removed', 'draw_agreement', 'takeback_accepted', 'offer_created', 'recovery_attempt', 'illegal_move_loss', 'abandonment_claim'));
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_result_scope_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_result_scope_check CHECK (event_kind IN ('move', 'resign', 'abort', 'cancel', 'timeout', 'draw_agreement', 'illegal_move_loss', 'abandonment_claim') OR result IS NULL);

-- Runtime grants. Roles are cluster-scoped, so creation is best effort: a
-- migration role without CREATEROLE still applies the schema and skips grants.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['kamkm_online_api', 'kamkm_online_rules'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'KHA-70: role % not created; runtime grants skipped', role_name;
      END;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_presence TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    -- USAGE without table privileges: the rules process receives versioned input
    -- over its private channel and has no independent database authority.
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_presence FROM PUBLIC;
