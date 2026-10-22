-- KHA-71 schema version 8. Service health checkpoints, suspension boundaries
-- and the canonical recovery adjustment.
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

-- The service epochs fence old work.
--
-- An epoch is opened by a recovery, not by every process start: several API
-- instances share one service, so an instance that merely joins must not
-- invalidate the leases of its peers. The epoch therefore advances exactly
-- once per detected interruption, under the recovery leadership lock.
CREATE TABLE IF NOT EXISTS online_service_epochs (
  epoch bigint PRIMARY KEY CHECK (epoch >= 1),
  started_at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 256)
);

-- The durable health checkpoints. A checkpoint is written whenever the service
-- records its own health, so an unexpected restart can derive a conservative
-- interruption interval from durable state instead of from a guess.
--
-- The checkpoint identity is an explicit key written by the service. There is
-- no sequence, so the runtime role needs no sequence privilege and a grant
-- audit cannot miss a hidden sequence dependency.
CREATE TABLE IF NOT EXISTS online_service_health (
  checkpoint_id text PRIMARY KEY CHECK (checkpoint_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  dependency text NOT NULL CHECK (dependency IN ('database', 'rules')),
  state text NOT NULL CHECK (state IN ('healthy', 'degraded', 'unavailable')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 256),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS online_service_health_recorded ON online_service_health(recorded_at DESC);
CREATE INDEX IF NOT EXISTS online_service_health_dependency ON online_service_health(dependency, recorded_at DESC);

-- The bounded liveness singleton. The service refreshes it on every check,
-- so an unexpected failure can be located after hours of healthy service
-- without a growing checkpoint table. A restart that finds a fresh record
-- knows that the service was alive and joins it without touching the epoch of
-- its peers.
CREATE TABLE IF NOT EXISTS online_service_liveness (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The suspension boundaries. A planned suspension is persisted before the
-- service stops, so its interval is known exactly. An unexpected suspension
-- is derived from the durable health checkpoints and the accepted match
-- activity when the service comes back.
--
-- A boundary identifies one interruption. The canonical adjustment for that
-- interruption is applied exactly once per match: the adjustment table is
-- keyed by the match and the boundary, so replaying a boundary never shifts a
-- deadline twice. Two distinct interruptions are two distinct boundaries, and
-- each of them may adjust an unfinished deadline once.
CREATE TABLE IF NOT EXISTS online_suspension_boundaries (
  boundary_id text PRIMARY KEY CHECK (boundary_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  kind text NOT NULL CHECK (kind IN ('planned', 'unexpected')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  resumed_at timestamptz,
  adjusted_at timestamptz,
  service_epoch bigint NOT NULL CHECK (service_epoch >= 1),
  interruption_ms bigint NOT NULL CHECK (interruption_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (resumed_at IS NULL OR ended_at IS NULL OR resumed_at >= ended_at),
  CHECK ((adjusted_at IS NULL) = (resumed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS online_suspension_boundaries_pending ON online_suspension_boundaries(adjusted_at) WHERE adjusted_at IS NULL;

-- The canonical recovery adjustments. One row per adjusted match and
-- boundary, so a repeated recovery of the same boundary can never adjust the
-- same match twice.
CREATE TABLE IF NOT EXISTS online_recovery_adjustments (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  boundary_id text NOT NULL REFERENCES online_suspension_boundaries(boundary_id),
  shift_ms bigint NOT NULL CHECK (shift_ms >= 0),
  previous_deadline_at timestamptz,
  new_deadline_at timestamptz,
  adjusted_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, boundary_id)
);

-- The clock remembers the recovery it received. The values are informational:
-- the exactly-once rule belongs to the adjustment table, so a later and
-- distinct interruption may adjust the same unfinished deadline once more.
ALTER TABLE online_clocks ADD COLUMN IF NOT EXISTS recovery_adjusted_at timestamptz;
ALTER TABLE online_clocks ADD COLUMN IF NOT EXISTS recovery_shift_ms bigint NOT NULL DEFAULT 0;

-- The recovery adjustment is part of the versioned match state, so the update
-- stream publishes the canonical deadline before resumed actions are accepted.
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_event_kind_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_event_kind_check CHECK (event_kind IN ('match_created', 'move', 'resign', 'abort', 'cancel', 'control_change', 'timeout', 'replay_removed', 'draw_agreement', 'takeback_accepted', 'offer_created', 'recovery_attempt', 'illegal_move_loss', 'abandonment_claim', 'recovery_adjustment'));
ALTER TABLE online_events ADD COLUMN IF NOT EXISTS recovery_shift_ms bigint;
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_recovery_shift_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_recovery_shift_check CHECK ((event_kind = 'recovery_adjustment') = (recovery_shift_ms IS NOT NULL));

-- Runtime grants. Roles are cluster-scoped, so creation is best effort: a
-- migration role without CREATEROLE still applies the schema and skips grants.
-- The online tables use explicit keys only, so no sequence privilege is
-- needed by the API role and no sequence is left ungranted.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['kamkm_online_api', 'kamkm_online_rules'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'KHA-71: role % not created; runtime grants skipped', role_name;
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_service_epochs TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_service_health TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_service_liveness TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_suspension_boundaries TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_recovery_adjustments TO kamkm_online_api', schema_name);
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
REVOKE ALL PRIVILEGES ON TABLE online_service_epochs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_service_health FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_suspension_boundaries FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_recovery_adjustments FROM PUBLIC;
