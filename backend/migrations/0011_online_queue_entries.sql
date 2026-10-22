-- KHA-76 public matchmaking queue state. Additive only.
--
-- Nothing in this file alters, rewrites, or re-grants the private
-- single-owner sync tables from 0001_storage.sql, and no existing shared row
-- is rewritten. The queue tables keep no foreign keys into the private
-- archive and never store provider credentials, raw provider requests, AI
-- conversation, private endpoints, or owner archives.
--
-- Go is the only transaction writer. The kamkm_online_rules runtime role
-- keeps schema USAGE and no table privileges, so the private rules process
-- cannot read or write canonical online state.

-- The wire contract of an entry carries one status, but the service needs a
-- finer internal state to answer the questions the product asks:
--
--   preparing  the entry exists and was not accepted as ready yet
--   waiting    the entry is searching for a compatible opponent
--   reserved   the entry is being assigned (the queue never persists it,
--              because the allocation is one transaction)
--   fallback   the cutoff was reached and no candidate was available, so the
--              browser engine fallback may be committed
--   expired    the owner stopped responding; the entry is out of eligibility
--              and only an explicit rejoin revives it
--   cancelled  the owner cancelled the entry
--   assigned   the entry produced exactly one game
ALTER TABLE online_queue_entries
  ADD COLUMN IF NOT EXISTS internal_state text NOT NULL DEFAULT 'waiting',
  ADD COLUMN IF NOT EXISTS original_cutoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS keep_searching boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS creation_hash bytea;

-- The internal state is a closed vocabulary. An unknown state is a bug, not a
-- new behaviour.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_internal_state_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_internal_state_check
  CHECK (internal_state IN ('preparing', 'waiting', 'reserved', 'fallback', 'expired', 'cancelled', 'assigned'));

-- Only an account enters the public queue. A guest is refused at the route
-- and again here, so no guest entry can exist even if a caller reaches the
-- writer directly.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_owner_kind_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_owner_kind_check CHECK (owner_kind = 'account');

-- The client request identifier is the idempotency key of one entry intent.
-- It is an opaque, non-secret value that only has to be stable per owner.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_client_request_id_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_client_request_id_check
  CHECK (client_request_id IS NULL OR client_request_id ~ '^[A-Za-z0-9_-]{8,64}$');

-- The wire status and the internal state always agree.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_state_pair_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_state_pair_check CHECK (
  (status = 'assigned' AND internal_state = 'assigned') OR
  (status = 'cancelled' AND internal_state = 'cancelled') OR
  (status = 'waiting' AND internal_state IN ('preparing', 'waiting', 'reserved', 'fallback', 'expired'))
);

-- The original cutoff is the deadline the ready acceptance armed. It never
-- moves while the entry waits, so a delayed timer resolves the deadline the
-- owner was promised.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_original_cutoff_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_original_cutoff_check
  CHECK (original_cutoff_at IS NULL OR ready_at IS NOT NULL);

-- Keeping the search removes the automatic cutoff, so the entry never falls
-- back to the browser engine on its own. The flag survives the assignment:
-- it records how the entry was searched.
ALTER TABLE online_queue_entries DROP CONSTRAINT IF EXISTS online_queue_entries_keep_searching_check;
ALTER TABLE online_queue_entries ADD CONSTRAINT online_queue_entries_keep_searching_check
  CHECK (keep_searching = false OR cutoff_at IS NULL);

-- One entry intent per owner. A second tab that replays the same client
-- request identifier finds the same entry instead of creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS online_queue_entries_client_request
  ON online_queue_entries(owner_kind, owner_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- The candidate scan reads one time-control bucket and asks for the oldest
-- ready entry. The index keeps that scan off a sequential read of every
-- stored entry.
CREATE INDEX IF NOT EXISTS online_queue_entries_candidate
  ON online_queue_entries(starting_time_ms, increment_ms, ready_at, entry_id)
  WHERE internal_state = 'waiting';

-- The delayed timer reads the entries whose original cutoff has passed.
CREATE INDEX IF NOT EXISTS online_queue_entries_due
  ON online_queue_entries(original_cutoff_at, entry_id)
  WHERE internal_state = 'waiting' AND keep_searching = false;

-- The expiry sweep reads the entries whose readiness lease has run out.
CREATE INDEX IF NOT EXISTS online_queue_entries_expiry
  ON online_queue_entries(expires_at, entry_id)
  WHERE internal_state = 'waiting';

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
        RAISE NOTICE 'KHA-76: role % not created; runtime grants skipped', role_name;
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_queue_entries TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- The queue tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_queue_entries FROM PUBLIC;
