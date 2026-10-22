-- KHA-79 the narrow redaction path of the queue tables. Additive only.
--
-- The auxiliary records of a removed subject keep three things that the
-- previous redaction left in place:
--
--   - the declared model label of the removed participant in the queue
--     allocation, which is the personal alias of the removed participant;
--   - the client supplied idempotency key of the queue entry, which a browser
--     could reuse for another account and so correlate the removed account
--     with a later one;
--   - the capability hashes of the friend records: the revocable ownership
--     secret of the inviter and the acceptance key of the acceptor.
--
-- The redaction of the allocation and of the entry therefore accepts the
-- declared model label and the client request identifier, and the privacy
-- service clears the capability hashes of the friend records.
--
-- The removal request is the authority of the redaction, so it may not be
-- deleted: a request that could be withdrawn would withdraw the authority
-- with it.

-- The removal request is durable. It may only move from verified to applied.
DROP TRIGGER IF EXISTS online_removal_requests_immutable_delete ON online_removal_requests;
CREATE TRIGGER online_removal_requests_immutable_delete BEFORE DELETE ON online_removal_requests
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- The queue entry guard accepts the redaction of a removed account, and the
-- clearing of the client supplied idempotency key with it.
CREATE OR REPLACE FUNCTION online_guard_queue_entry_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The redaction of a removed account is the one change the identity guard
  -- accepts. It replaces the owner identifier with the reserved anonymized
  -- value, replaces the declared model label with the neutral label of a
  -- model opponent and clears the client supplied idempotency key, which a
  -- browser could reuse for another account. The seat, the clock and the
  -- assignment stay exactly as they were.
  IF NEW.owner_id = 'anonymized' AND OLD.owner_id <> 'anonymized' THEN
    IF NOT online_removed_account_request(OLD.owner_id) THEN
      RAISE EXCEPTION 'online queue entry redaction needs a removal request' USING ERRCODE = '55000';
    END IF;
    IF NEW.entry_id <> OLD.entry_id
       OR NEW.owner_kind <> OLD.owner_kind
       OR NEW.seat_control_kind <> OLD.seat_control_kind
       OR NEW.starting_time_ms <> OLD.starting_time_ms
       OR NEW.increment_ms <> OLD.increment_ms
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'online queue entry identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.client_request_id IS NOT NULL AND NEW.client_request_id IS DISTINCT FROM OLD.client_request_id THEN
      RAISE EXCEPTION 'online queue entry redaction keeps the client request identifier' USING ERRCODE = '55000';
    END IF;
    -- The declared model label of a model seat is replaced by the neutral
    -- label. A human seat has no model label, so it stays empty.
    IF NEW.seat_control_model_label IS DISTINCT FROM (
         CASE WHEN NEW.seat_control_kind = 'human' THEN NULL ELSE 'Custom model' END) THEN
      RAISE EXCEPTION 'online queue entry redaction keeps the canonical model label' USING ERRCODE = '55000';
    END IF;
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'online queue entry version must advance' USING ERRCODE = '55000';
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

-- The allocation guard accepts the redaction of the public label and of the
-- declared model label of a removed participant.
--
-- The redaction is exact: the label of a side becomes the canonical sanitized
-- label, the declared model label of that side becomes the neutral label of a
-- model opponent, and nothing else of the allocation changes. The other
-- participant keeps its own label, its own control kind and its own model
-- label, and the identity of the allocation never changes.
CREATE OR REPLACE FUNCTION online_guard_queue_allocation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.initiator_label IS DISTINCT FROM OLD.initiator_label)
     OR (NEW.opponent_label IS DISTINCT FROM OLD.opponent_label)
     OR (NEW.initiator_control_model_label IS DISTINCT FROM OLD.initiator_control_model_label)
     OR (NEW.opponent_control_model_label IS DISTINCT FROM OLD.opponent_control_model_label) THEN
    -- The identity of the allocation never changes: not the operation key,
    -- not the entries it refers to, not the seats, not the control kinds.
    IF NEW.allocation_id <> OLD.allocation_id
       OR NEW.kind <> OLD.kind
       OR NEW.initiator_entry_id <> OLD.initiator_entry_id
       OR NEW.initiator_seat <> OLD.initiator_seat
       OR NEW.opponent_entry_id IS DISTINCT FROM OLD.opponent_entry_id
       OR NEW.opponent_seat <> OLD.opponent_seat
       OR NEW.operation_id <> OLD.operation_id
       OR NEW.match_id IS DISTINCT FROM OLD.match_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.status <> OLD.status
       OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
       OR NEW.initiator_control_kind <> OLD.initiator_control_kind
       OR NEW.opponent_control_kind <> OLD.opponent_control_kind THEN
      RAISE EXCEPTION 'online queue allocation identity is immutable' USING ERRCODE = '55000';
    END IF;
    -- The initiator side is redacted only when the initiator is a removed
    -- participant, and only to the canonical sanitized values.
    IF NEW.initiator_label IS DISTINCT FROM OLD.initiator_label THEN
      IF NEW.initiator_label <> 'Deleted player' THEN
        RAISE EXCEPTION 'online queue allocation label may only be sanitized' USING ERRCODE = '55000';
      END IF;
      IF NEW.initiator_control_model_label IS DISTINCT FROM (
           CASE WHEN NEW.initiator_control_kind = 'human' THEN NULL ELSE 'Custom model' END) THEN
        RAISE EXCEPTION 'online queue allocation redaction keeps the canonical model label' USING ERRCODE = '55000';
      END IF;
      IF NOT online_removed_account_request(
        (SELECT q.owner_id FROM online_queue_allocation_entries e JOIN online_queue_entries q ON q.entry_id = e.entry_id
         WHERE e.allocation_id = OLD.allocation_id AND e.role = 'initiator')) THEN
        RAISE EXCEPTION 'online queue allocation redaction needs a removal request' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.initiator_control_model_label IS DISTINCT FROM OLD.initiator_control_model_label THEN
      RAISE EXCEPTION 'online queue allocation redaction changes one side only' USING ERRCODE = '55000';
    END IF;
    -- The opponent side is redacted only when the opponent is a removed
    -- participant, and only to the canonical sanitized values.
    IF NEW.opponent_label IS DISTINCT FROM OLD.opponent_label THEN
      IF NEW.opponent_label <> 'Deleted player' THEN
        RAISE EXCEPTION 'online queue allocation label may only be sanitized' USING ERRCODE = '55000';
      END IF;
      IF NEW.opponent_control_model_label IS DISTINCT FROM (
           CASE WHEN NEW.opponent_control_kind = 'human' THEN NULL ELSE 'Custom model' END) THEN
        RAISE EXCEPTION 'online queue allocation redaction keeps the canonical model label' USING ERRCODE = '55000';
      END IF;
      IF NOT online_removed_account_request(
        (SELECT q.owner_id FROM online_queue_allocation_entries e JOIN online_queue_entries q ON q.entry_id = e.entry_id
         WHERE e.allocation_id = OLD.allocation_id AND e.role = 'opponent')) THEN
        RAISE EXCEPTION 'online queue allocation redaction needs a removal request' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.opponent_control_model_label IS DISTINCT FROM OLD.opponent_control_model_label THEN
      RAISE EXCEPTION 'online queue allocation redaction changes one side only' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- The identity of an allocation never changes. The public label of both
  -- participants and the declared control of both stay fixed, because a
  -- recovered reservation has to rebuild exactly the same match.
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
