-- KHA-79 removal requests, the durable removal ledger, and the account
-- deletion record. Additive only.
--
-- Ordinary account deletion and explicit removal are two separate flows with
-- two separate scopes, and both are recorded here.
--
-- The removal ledger is the online counterpart of the private backup deletion
-- ledger. It lists every match whose shared replay or identifying snapshot a
-- removal touched. A restore of an older backup replays the ledger before the
-- restored database serves traffic, so an erased game or a removed identity
-- cannot reappear.
--
-- The ledger records a removal. It never stores the removed content, and it
-- never stores a credential, a session, a provider request, or a private
-- endpoint.

CREATE TABLE IF NOT EXISTS online_removal_requests (
  removal_id text PRIMARY KEY CHECK (removal_id ~ '^rm_[A-Za-z0-9_-]{8,63}$'),
  subject_kind text NOT NULL CHECK (subject_kind IN ('account', 'guest')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  -- account_deletion anonymizes the shared games and keeps them.
  -- explicit_removal erases the shared replays from both histories.
  scope text NOT NULL CHECK (scope IN ('account_deletion', 'explicit_removal')),
  -- verified means the request proved ownership of the subject.
  -- applied means the removal was carried out.
  status text NOT NULL CHECK (status IN ('verified', 'applied')),
  requested_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  applied_at timestamptz,
  -- The operating targets of the specification: the live service data and the
  -- public projections are removed within twenty-four hours of the
  -- verification, and the recovery copies are sanitized within thirty days.
  live_delete_due_at timestamptz NOT NULL,
  live_deleted_at timestamptz,
  recovery_sanitize_due_at timestamptz NOT NULL,
  recovery_sanitized_at timestamptz,
  removed_match_count bigint NOT NULL DEFAULT 0 CHECK (removed_match_count >= 0),
  anonymized_match_count bigint NOT NULL DEFAULT 0 CHECK (anonymized_match_count >= 0),
  CHECK (verified_at >= requested_at),
  CHECK (applied_at IS NULL OR applied_at >= verified_at),
  CHECK (live_deleted_at IS NULL OR live_deleted_at >= verified_at),
  CHECK (recovery_sanitized_at IS NULL OR recovery_sanitized_at >= verified_at),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
-- One request per subject and scope. The unique index is what makes a repeated
-- request idempotent instead of a second removal.
CREATE UNIQUE INDEX IF NOT EXISTS online_removal_requests_subject ON online_removal_requests(subject_kind, subject_id, scope);
CREATE INDEX IF NOT EXISTS online_removal_requests_recovery ON online_removal_requests(recovery_sanitize_due_at) WHERE recovery_sanitized_at IS NULL;

-- The durable removal ledger.
--
-- One row per removed match. The row is the record that the shared replay and
-- the identifying snapshots of that match must not be served again, whatever a
-- restored backup contains.
CREATE TABLE IF NOT EXISTS online_removal_ledger (
  ledger_id text PRIMARY KEY CHECK (ledger_id ~ '^rl_[A-Za-z0-9_-]{8,63}$'),
  removal_id text NOT NULL REFERENCES online_removal_requests(removal_id) ON DELETE RESTRICT,
  subject_kind text NOT NULL CHECK (subject_kind IN ('account', 'guest')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  match_id text NOT NULL CHECK (length(match_id) BETWEEN 8 AND 64),
  scope text NOT NULL CHECK (scope IN ('account_deletion', 'explicit_removal')),
  removed_at timestamptz NOT NULL,
  UNIQUE (removal_id, match_id)
);
CREATE INDEX IF NOT EXISTS online_removal_ledger_match ON online_removal_ledger(match_id);
CREATE INDEX IF NOT EXISTS online_removal_ledger_subject ON online_removal_ledger(subject_kind, subject_id);

-- The account deletion record.
--
-- An ordinary deletion keeps the shared games as anonymized games. The record
-- states that the account's own public identity and its service-held private
-- owner data were removed, and it links the removal request that carries the
-- ledger entries.
CREATE TABLE IF NOT EXISTS online_account_deletions (
  deletion_id text PRIMARY KEY CHECK (deletion_id ~ '^rd_[A-Za-z0-9_-]{8,63}$'),
  account_id text NOT NULL UNIQUE CHECK (length(account_id) BETWEEN 1 AND 128),
  requested_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL,
  removal_id text NOT NULL REFERENCES online_removal_requests(removal_id) ON DELETE RESTRICT,
  CHECK (applied_at >= requested_at)
);

-- The removal record is durable.
--
-- The identity of a request never changes: the subject, the scope, the
-- verification time, and the retention deadlines are fixed when the request
-- is verified. Only the processing fields move, and each of them moves once.
CREATE OR REPLACE FUNCTION online_guard_removal_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removal_id <> OLD.removal_id
     OR NEW.subject_kind <> OLD.subject_kind
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.scope <> OLD.scope
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.verified_at <> OLD.verified_at
     OR NEW.live_delete_due_at <> OLD.live_delete_due_at
     OR NEW.recovery_sanitize_due_at <> OLD.recovery_sanitize_due_at THEN
    RAISE EXCEPTION 'online removal request identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'verified' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'online removal request status is final' USING ERRCODE = '55000';
  END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'online removal request application time is final' USING ERRCODE = '55000';
  END IF;
  IF OLD.live_deleted_at IS NOT NULL AND NEW.live_deleted_at IS DISTINCT FROM OLD.live_deleted_at THEN
    RAISE EXCEPTION 'online removal request live deletion time is final' USING ERRCODE = '55000';
  END IF;
  IF OLD.recovery_sanitized_at IS NOT NULL AND NEW.recovery_sanitized_at IS DISTINCT FROM OLD.recovery_sanitized_at THEN
    RAISE EXCEPTION 'online removal request recovery time is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.removed_match_count < OLD.removed_match_count OR NEW.anonymized_match_count < OLD.anonymized_match_count THEN
    RAISE EXCEPTION 'online removal request counters only grow' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_removal_requests_guard ON online_removal_requests;
CREATE TRIGGER online_removal_requests_guard BEFORE UPDATE ON online_removal_requests
  FOR EACH ROW EXECUTE FUNCTION online_guard_removal_request_update();

-- The ledger entry is durable: it is never rewritten and never deleted.
CREATE OR REPLACE FUNCTION online_guard_removal_record_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'online removal record is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS online_removal_ledger_guard ON online_removal_ledger;
CREATE TRIGGER online_removal_ledger_guard BEFORE UPDATE ON online_removal_ledger
  FOR EACH ROW EXECUTE FUNCTION online_guard_removal_record_update();

DROP TRIGGER IF EXISTS online_removal_ledger_immutable_delete ON online_removal_ledger;
CREATE TRIGGER online_removal_ledger_immutable_delete BEFORE DELETE ON online_removal_ledger
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

DROP TRIGGER IF EXISTS online_account_deletions_immutable_delete ON online_account_deletions;
CREATE TRIGGER online_account_deletions_immutable_delete BEFORE DELETE ON online_account_deletions
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants follow the KHA-65 pattern.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_removal_requests TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_removal_ledger TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_account_deletions TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_removal_requests FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_removal_ledger FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_account_deletions FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_removal_requests FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_removal_ledger FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_account_deletions FROM PUBLIC;
