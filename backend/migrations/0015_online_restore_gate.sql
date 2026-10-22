-- KHA-79 the restore gate and the one-way subject reference. Additive only.
--
-- The restore gate records that a database was restored from a backup. The
-- restored database may serve traffic only after the newest removal ledger
-- has been replayed, so an erased game or a removed identity cannot reappear
-- through an older backup.
--
-- The subject reference is the one-way reference of a removed subject. The
-- seat guard accepts a deletion marker that carries the reference, so the
-- marker table never retains the identifier of an erased subject. The
-- reference is derived with a domain separation, so it cannot be compared
-- with a hash of the same value in another context.

CREATE TABLE IF NOT EXISTS online_restore_gates (
  gate_id text PRIMARY KEY CHECK (gate_id ~ '^rg_[A-Za-z0-9_-]{8,63}$'),
  restore_id text NOT NULL UNIQUE CHECK (length(restore_id) BETWEEN 1 AND 128),
  -- The digest of the removal ledger that was applied to the restored
  -- database.
  ledger_digest bytea NOT NULL CHECK (octet_length(ledger_digest) = 32),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A restored database serves traffic only after the gate is released.
  serving_allowed boolean NOT NULL DEFAULT false,
  released_at timestamptz,
  CHECK ((serving_allowed) = (released_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS online_restore_gates_pending ON online_restore_gates(recorded_at DESC) WHERE serving_allowed = false;

-- The gate is released once and never taken back.
CREATE OR REPLACE FUNCTION online_guard_restore_gate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gate_id <> OLD.gate_id OR NEW.restore_id <> OLD.restore_id
     OR NEW.ledger_digest <> OLD.ledger_digest OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'online restore gate identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.serving_allowed AND (NEW.serving_allowed IS DISTINCT FROM OLD.serving_allowed OR NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'online restore gate release is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_restore_gates_guard ON online_restore_gates;
CREATE TRIGGER online_restore_gates_guard BEFORE UPDATE ON online_restore_gates
  FOR EACH ROW EXECUTE FUNCTION online_guard_restore_gate_update();

DROP TRIGGER IF EXISTS online_restore_gates_immutable_delete ON online_restore_gates;
CREATE TRIGGER online_restore_gates_immutable_delete BEFORE DELETE ON online_restore_gates
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- The seat guard accepts a deletion marker that names the subject by its
-- one-way reference.
--
-- The guard is otherwise unchanged: the seat owner is never reassigned, the
-- anonymization is final, and the anonymization needs a recorded marker for
-- the exact seat owner. The reference is the same value the removal service
-- writes, so a removal that erased an account never leaves the account
-- identifier in the marker table.
CREATE OR REPLACE FUNCTION online_guard_seat_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id <> OLD.match_id OR NEW.seat <> OLD.seat OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'online seat identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind THEN
    IF OLD.owner_id = 'anonymized' THEN
      RAISE EXCEPTION 'online seat anonymization is final' USING ERRCODE = '55000';
    END IF;
    IF NEW.owner_kind <> OLD.owner_kind OR NEW.owner_id <> 'anonymized' OR NEW.public_label <> 'Deleted player' THEN
      RAISE EXCEPTION 'online seat ownership may only be anonymized' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM online_deletion_markers
      WHERE marker_kind = 'account_anonymization'
        AND subject_kind = OLD.owner_kind
        AND (
          subject_id = OLD.owner_id
          OR subject_id = encode(sha256(convert_to('kamkm.online.removal.v1:' || OLD.owner_id, 'UTF8')), 'hex')
        )
        AND reason IN ('account_deletion', 'erasure_request')
    ) THEN
      RAISE EXCEPTION 'online seat anonymization needs a deletion marker' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_seats_guard ON online_seats;
CREATE TRIGGER online_seats_guard BEFORE UPDATE ON online_seats
  FOR EACH ROW EXECUTE FUNCTION online_guard_seat_update();

-- Runtime grants follow the KHA-65 pattern.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_restore_gates TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_restore_gates FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_restore_gates FROM PUBLIC;
