-- KHA-79 the narrow redaction path of the queue tables. Additive only.
--
-- A removed account keeps no personal data in the queue tables. The waiting
-- entries of the account are deleted, and the entries that already produced a
-- match keep their row: the allocation and the match refer to it.
--
-- The identity of a queue entry is immutable, so the redaction of the owner
-- needs its own narrow path. The path is only open when a removal request of
-- the account exists, and it only replaces the owner identifier and the
-- declared model label. Everything else about the entry stays immutable.
--
-- The allocation keeps the public label of both participants, so it is
-- redacted the same way: only the labels of an allocation whose entry belongs
-- to a removed account change, and only with a recorded removal request.
--
-- The redaction never changes a result, a match or an allocation identity.

-- The redaction of a removed account is accepted only with a recorded
-- removal request of that account.
CREATE OR REPLACE FUNCTION online_removed_account_request(p_owner_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM online_removal_requests
    WHERE subject_kind = 'account'
      AND subject_id = encode(sha256(convert_to('kamkm.online.removal.v1:' || p_owner_id, 'UTF8')), 'hex')
      AND scope IN ('account_deletion', 'explicit_removal'))
$$;

-- The queue entry guard accepts the redaction of a removed account.
CREATE OR REPLACE FUNCTION online_guard_queue_entry_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The redaction of a removed account is the one change the identity guard
  -- accepts. It replaces the owner identifier with the reserved anonymized
  -- value and drops the declared model label. The seat, the clock, the client
  -- request and the assignment stay exactly as they were.
  IF NEW.owner_id = 'anonymized' AND OLD.owner_id <> 'anonymized' THEN
    IF NOT online_removed_account_request(OLD.owner_id) THEN
      RAISE EXCEPTION 'online queue entry redaction needs a removal request' USING ERRCODE = '55000';
    END IF;
    IF NEW.entry_id <> OLD.entry_id
       OR NEW.owner_kind <> OLD.owner_kind
       OR NEW.seat_control_kind <> OLD.seat_control_kind
       OR NEW.starting_time_ms <> OLD.starting_time_ms
       OR NEW.increment_ms <> OLD.increment_ms
       OR NEW.created_at <> OLD.created_at
       OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id THEN
      RAISE EXCEPTION 'online queue entry identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> OLD.status OR NEW.assigned_match_id IS DISTINCT FROM OLD.assigned_match_id THEN
      RAISE EXCEPTION 'online queue entry assignment is final' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
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

-- The allocation guard accepts the redaction of the public labels of a removed
-- participant.
CREATE OR REPLACE FUNCTION online_guard_queue_allocation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The redaction of a removed participant only changes the public labels of
  -- the allocation. Everything else, the identity and the committed result,
  -- stays exactly as it was.
  IF NEW.initiator_label = 'Deleted player' AND OLD.initiator_label <> 'Deleted player' THEN
    IF NOT online_removed_account_request(
      (SELECT q.owner_id FROM online_queue_allocation_entries e JOIN online_queue_entries q ON q.entry_id = e.entry_id
       WHERE e.allocation_id = OLD.allocation_id AND e.role = 'initiator')) THEN
      RAISE EXCEPTION 'online queue allocation redaction needs a removal request' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.opponent_label = 'Deleted player' AND OLD.opponent_label <> 'Deleted player' THEN
    IF NOT online_removed_account_request(
      (SELECT q.owner_id FROM online_queue_allocation_entries e JOIN online_queue_entries q ON q.entry_id = e.entry_id
       WHERE e.allocation_id = OLD.allocation_id AND e.role = 'opponent')) THEN
      RAISE EXCEPTION 'online queue allocation redaction needs a removal request' USING ERRCODE = '55000';
    END IF;
  ELSE
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
  END IF;
  RETURN NEW;
END
$$;
