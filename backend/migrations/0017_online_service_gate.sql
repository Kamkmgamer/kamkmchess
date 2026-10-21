-- KHA-71 follow-up schema version 16. The durable admission gate of the
-- online service.
--
-- Additive only. Nothing in this file alters, rewrites, or re-grants the
-- private single-owner sync tables from 0001_storage.sql, and no existing
-- shared row is rewritten. The online tables keep no foreign keys into the
-- private archive and never store provider credentials, raw provider
-- requests, AI conversation, private endpoints, or owner archives.
--
-- The gate itself is derived. It reads three durable sources that already
-- exist:
--
--   - online_restore_gates: a restored database that did not replay the
--     removal ledger yet (migration 0015, owned by the removal flow);
--   - online_suspension_boundaries: a planned suspension or an interruption
--     that was not applied yet;
--   - online_service_epochs: an epoch whose recovery has not completed.
--
-- The only addition is the completion time of a service epoch. An epoch is
-- opened when an interruption is detected and it is completed when the
-- canonical recovery published the adjusted state, so an epoch without a
-- completion time is the durable evidence that the service is still
-- recovering.

ALTER TABLE online_service_epochs ADD COLUMN IF NOT EXISTS recovered_at timestamptz;

-- The completion of an epoch is written once, and only by the recovery that
-- published the adjusted state of that epoch.
CREATE OR REPLACE FUNCTION online_guard_service_epoch_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch <> OLD.epoch OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'online service epoch identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.recovered_at IS NOT NULL AND NEW.recovered_at IS DISTINCT FROM OLD.recovered_at THEN
    RAISE EXCEPTION 'online service epoch recovery is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.recovered_at IS NOT NULL AND NEW.recovered_at < OLD.started_at THEN
    RAISE EXCEPTION 'online service epoch recovery precedes its start' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_service_epochs_guard ON online_service_epochs;
CREATE TRIGGER online_service_epochs_guard BEFORE UPDATE ON online_service_epochs
FOR EACH ROW EXECUTE FUNCTION online_guard_service_epoch_update();

-- Runtime grants follow the KHA-65 pattern.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_service_epochs TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;
