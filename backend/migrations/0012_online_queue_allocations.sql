-- KHA-76 authoritative queue allocations. Additive only.
--
-- One allocation records the single authoritative decision that paired two
-- owners or committed the browser engine fallback. The allocation is written
-- before the match exists and is completed after it exists: a pending
-- allocation is durable and recoverable, because it names the idempotency
-- key of the match, so a retry produces the same match instead of a second
-- one.
--
-- Every consumed entry appears in exactly one row of
-- online_queue_allocation_entries. The unique index on that table is the
-- database fact behind the product rule: an entry is consumed once, so one
-- entry can never produce two games, in any role.

CREATE TABLE IF NOT EXISTS online_queue_allocations (
  allocation_id text PRIMARY KEY CHECK (allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  -- candidate: two owners were paired. fallback: the browser engine took the
  -- other seat.
  kind text NOT NULL CHECK (kind IN ('candidate', 'fallback')),
  -- The entry that asked for the allocation and the seat it plays.
  initiator_entry_id text NOT NULL REFERENCES online_queue_entries(entry_id),
  initiator_seat text NOT NULL CHECK (initiator_seat IN ('white', 'black')),
  -- The other entry of a candidate match. A fallback has none: the engine is
  -- not an entry.
  opponent_entry_id text REFERENCES online_queue_entries(entry_id),
  opponent_seat text NOT NULL CHECK (opponent_seat IN ('white', 'black')),
  -- The idempotency key of the match creation. The match identifier is
  -- derived from it, so a retry names the same match.
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  -- The canonical match this allocation produced. It is empty while the
  -- allocation is pending.
  match_id text REFERENCES online_matches(match_id),
  -- pending: the decision is durable and the match is not written yet.
  -- committed: the match exists and the entries are assigned.
  status text NOT NULL CHECK (status IN ('pending', 'committed')),
  -- The public label and the declared control of both participants. The
  -- allocation stores them so a recovered reservation rebuilds exactly the
  -- same match, even when an owner changed their public name in the
  -- meantime.
  initiator_label text NOT NULL CHECK (
    length(initiator_label) BETWEEN 1 AND 64
    AND initiator_label !~ '[[:cntrl:]]'
    AND initiator_label !~ '[@]'
    AND position('://' in initiator_label) = 0
  ),
  initiator_control_kind text NOT NULL CHECK (initiator_control_kind IN ('human', 'agent', 'engine')),
  initiator_control_model_label text CHECK (
    initiator_control_model_label IS NULL OR (
      length(initiator_control_model_label) BETWEEN 1 AND 64
      AND initiator_control_model_label !~ '[[:cntrl:]]'
      AND initiator_control_model_label !~ '[@]'
      AND position('://' in initiator_control_model_label) = 0
    )
  ),
  opponent_label text NOT NULL CHECK (
    length(opponent_label) BETWEEN 1 AND 64
    AND opponent_label !~ '[[:cntrl:]]'
    AND opponent_label !~ '[@]'
    AND position('://' in opponent_label) = 0
  ),
  opponent_control_kind text NOT NULL CHECK (opponent_control_kind IN ('human', 'agent', 'engine')),
  opponent_control_model_label text CHECK (
    opponent_control_model_label IS NULL OR (
      length(opponent_control_model_label) BETWEEN 1 AND 64
      AND opponent_control_model_label !~ '[[:cntrl:]]'
      AND opponent_control_model_label !~ '[@]'
      AND position('://' in opponent_control_model_label) = 0
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  CHECK (initiator_seat <> opponent_seat),
  CHECK (initiator_entry_id <> opponent_entry_id),
  CHECK ((kind = 'candidate') = (opponent_entry_id IS NOT NULL)),
  CHECK ((initiator_control_kind = 'human') = (initiator_control_model_label IS NULL)),
  CHECK ((opponent_control_kind = 'human') = (opponent_control_model_label IS NULL)),
  CHECK ((status = 'committed') = (match_id IS NOT NULL)),
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS online_queue_allocations_match ON online_queue_allocations(match_id);
-- The recovery sweep reads the allocations whose match is not written yet.
CREATE INDEX IF NOT EXISTS online_queue_allocations_pending
  ON online_queue_allocations(created_at, allocation_id) WHERE status = 'pending';

-- The consumed entries of an allocation.
--
-- One row per consumed entry. The unique index on the entry is the database
-- fact behind "one entry produces one game": an entry appears in at most one
-- allocation, as the initiator or as the opponent.
CREATE TABLE IF NOT EXISTS online_queue_allocation_entries (
  allocation_id text NOT NULL REFERENCES online_queue_allocations(allocation_id) ON DELETE CASCADE,
  entry_id text NOT NULL REFERENCES online_queue_entries(entry_id),
  -- The role the entry plays in the allocation.
  role text NOT NULL CHECK (role IN ('initiator', 'opponent')),
  PRIMARY KEY (allocation_id, entry_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS online_queue_allocation_entries_entry
  ON online_queue_allocation_entries(entry_id);
CREATE INDEX IF NOT EXISTS online_queue_allocation_entries_allocation
  ON online_queue_allocation_entries(allocation_id);

-- The entry guard refuses an assignment that no allocation backs. The guard
-- lives with the allocation tables because it reads them.
CREATE OR REPLACE FUNCTION online_guard_queue_entry_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The identity of an entry never changes. The seat, the declared model and
  -- the clock stay fixed while the entry waits, so a change of selection is a
  -- cancellation and a new entry, never an edit.
  IF NEW.entry_id <> OLD.entry_id
     OR NEW.owner_kind <> OLD.owner_kind
     OR NEW.owner_id <> OLD.owner_id
     OR NEW.seat_control_kind <> OLD.seat_control_kind
     OR NEW.seat_control_model_label IS DISTINCT FROM OLD.seat_control_model_label
     OR NEW.starting_time_ms <> OLD.starting_time_ms
     OR NEW.increment_ms <> OLD.increment_ms
     OR NEW.created_at <> OLD.created_at
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id THEN
    RAISE EXCEPTION 'online queue entry identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'online queue entry version must advance' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.status <> 'cancelled' OR NEW.internal_state <> 'cancelled') THEN
    RAISE EXCEPTION 'online queue entry cancellation is final' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'assigned'
     AND (NEW.status <> 'assigned' OR NEW.assigned_match_id IS DISTINCT FROM OLD.assigned_match_id) THEN
    RAISE EXCEPTION 'online queue entry assignment is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'assigned' AND NOT EXISTS (
    SELECT 1
    FROM online_queue_allocation_entries e
    JOIN online_queue_allocations a ON a.allocation_id = e.allocation_id
    WHERE e.entry_id = NEW.entry_id AND a.match_id = NEW.assigned_match_id AND a.status = 'committed'
  ) THEN
    RAISE EXCEPTION 'online queue entry assignment needs a committed allocation' USING ERRCODE = '55000';
  END IF;
  -- An expired entry leaves the eligibility on its own. Only an explicit
  -- rejoin brings it back, and a rejoin is a fresh window.
  IF OLD.internal_state = 'expired' AND NEW.internal_state NOT IN ('waiting', 'expired') THEN
    RAISE EXCEPTION 'online queue entry expiry is cleared only by an explicit rejoin' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_queue_entries_guard ON online_queue_entries;
CREATE TRIGGER online_queue_entries_guard BEFORE UPDATE ON online_queue_entries
FOR EACH ROW EXECUTE FUNCTION online_guard_queue_entry_update();

-- An allocation keeps its identity. The only change it accepts is the
-- completion of a pending allocation, which names the match that exists.
CREATE OR REPLACE FUNCTION online_guard_queue_allocation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.allocation_id <> OLD.allocation_id
     OR NEW.kind <> OLD.kind
     OR NEW.initiator_entry_id <> OLD.initiator_entry_id
     OR NEW.initiator_seat <> OLD.initiator_seat
     OR NEW.opponent_entry_id IS DISTINCT FROM OLD.opponent_entry_id
     OR NEW.opponent_seat <> OLD.opponent_seat
     OR NEW.operation_id <> OLD.operation_id
     OR NEW.initiator_label <> OLD.initiator_label
     OR NEW.initiator_control_kind <> OLD.initiator_control_kind
     OR NEW.initiator_control_model_label IS DISTINCT FROM OLD.initiator_control_model_label
     OR NEW.opponent_label <> OLD.opponent_label
     OR NEW.opponent_control_kind <> OLD.opponent_control_kind
     OR NEW.opponent_control_model_label IS DISTINCT FROM OLD.opponent_control_model_label
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'online queue allocation identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'committed' THEN
    RAISE EXCEPTION 'online queue allocation is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'committed' OR NEW.match_id IS NULL OR NEW.committed_at IS NULL THEN
    RAISE EXCEPTION 'online queue allocation can only be completed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_queue_allocations_guard ON online_queue_allocations;
CREATE TRIGGER online_queue_allocations_guard BEFORE UPDATE ON online_queue_allocations
FOR EACH ROW EXECUTE FUNCTION online_guard_queue_allocation_update();

DROP TRIGGER IF EXISTS online_queue_allocations_immutable_delete ON online_queue_allocations;
CREATE TRIGGER online_queue_allocations_immutable_delete BEFORE DELETE ON online_queue_allocations
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- The consumed entries of an allocation never change.
CREATE OR REPLACE FUNCTION online_guard_queue_allocation_entry_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'online queue allocation entry is append-only' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS online_queue_allocation_entries_guard ON online_queue_allocation_entries;
CREATE TRIGGER online_queue_allocation_entries_guard BEFORE UPDATE ON online_queue_allocation_entries
FOR EACH ROW EXECUTE FUNCTION online_guard_queue_allocation_entry_update();

DROP TRIGGER IF EXISTS online_queue_allocation_entries_immutable_delete ON online_queue_allocation_entries;
CREATE TRIGGER online_queue_allocation_entries_immutable_delete BEFORE DELETE ON online_queue_allocation_entries
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_queue_allocations TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_queue_allocation_entries TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- The new shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_queue_allocations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_queue_allocation_entries FROM PUBLIC;
