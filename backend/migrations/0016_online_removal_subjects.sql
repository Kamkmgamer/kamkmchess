-- KHA-79 the subject level removal record. Additive only.
--
-- A removal is recorded twice: once per shared match it touched, and once for
-- the subject itself.
--
-- The match bound records answer the question "which shared replay must not
-- come back". The subject record answers a different question: "this subject
-- was removed, whatever it played and whatever private data it held". An
-- account that only had private games never appears in a match bound record,
-- so without the subject record a restore of an older backup would lose the
-- removal entirely: the private data would come back and the account would
-- be able to use its old session again.
--
-- The subject record carries the one-way reference of the subject, never the
-- subject identifier, and it never names a match: the subject may have played
-- no match at all.
--
-- The record is carried in the encrypted backup bundle, merged with the newer
-- rotation copies and replayed after a restore, exactly like the match bound
-- records.

CREATE TABLE IF NOT EXISTS online_removal_subjects (
  subject_id text PRIMARY KEY CHECK (subject_id ~ '^rs_[A-Za-z0-9_-]{8,63}$'),
  removal_id text NOT NULL REFERENCES online_removal_requests(removal_id) ON DELETE RESTRICT,
  subject_kind text NOT NULL CHECK (subject_kind IN ('account', 'guest')),
  -- The one-way reference of the subject, never the subject identifier.
  subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 128),
  scope text NOT NULL CHECK (scope IN ('account_deletion', 'explicit_removal')),
  removed_at timestamptz NOT NULL,
  -- One record per subject and scope. The scope is part of the key, because an
  -- ordinary deletion and an explicit removal are two different removals.
  UNIQUE (subject_kind, subject_ref, scope)
);
CREATE INDEX IF NOT EXISTS online_removal_subjects_ref ON online_removal_subjects(subject_kind, subject_ref);

-- The subject record is durable: it is never rewritten and never deleted.
DROP TRIGGER IF EXISTS online_removal_subjects_guard ON online_removal_subjects;
CREATE TRIGGER online_removal_subjects_guard BEFORE UPDATE ON online_removal_subjects
  FOR EACH ROW EXECUTE FUNCTION online_guard_removal_record_update();

DROP TRIGGER IF EXISTS online_removal_subjects_immutable_delete ON online_removal_subjects;
CREATE TRIGGER online_removal_subjects_immutable_delete BEFORE DELETE ON online_removal_subjects
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants follow the KHA-65 pattern.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_removal_subjects TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_removal_subjects FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_removal_subjects FROM PUBLIC;
