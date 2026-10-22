-- KHA-73 schema version 9. Per-seat and per-turn runner leases, runner epochs
-- and the uncertain provider request record.
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
-- A lease is a browser's right to act for one seat of one match. It never
-- holds a credential, a provider route, a model conversation, or anything else
-- that belongs to the owner's browser. The pending request record holds an
-- opaque request identifier only, so a new runner can tell that the previous
-- runner may have started billable work without learning anything about it.

-- The turn the lease is bound to. A lease for an older turn is stale, so a
-- runner that lost a turn cannot act on the next one.
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS turn_version bigint CHECK (turn_version IS NULL OR turn_version >= 1);

-- The service epoch that owns the lease. A recovery opens a new epoch and
-- fences the leases of the older ones.
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS runner_epoch bigint NOT NULL DEFAULT 1 CHECK (runner_epoch >= 1);

-- The uncertain provider request. It is set while a runner has a billable
-- request in flight and cleared when that request settled deterministically.
-- A lease that is lost with a pending request offers an explicit Retry,
-- switch or takeover instead of another provider request.
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS pending_request_id text CHECK (pending_request_id IS NULL OR length(pending_request_id) BETWEEN 1 AND 128);
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS pending_request_started_at timestamptz;
ALTER TABLE online_runner_leases DROP CONSTRAINT IF EXISTS online_runner_leases_pending_request_check;
ALTER TABLE online_runner_leases ADD CONSTRAINT online_runner_leases_pending_request_check CHECK ((pending_request_id IS NULL) = (pending_request_started_at IS NULL));

-- The last renewal of the lease and the reason a lease ended.
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS last_renewed_at timestamptz;
ALTER TABLE online_runner_leases ADD COLUMN IF NOT EXISTS revoked_reason text CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 64);

CREATE INDEX IF NOT EXISTS online_runner_leases_epoch ON online_runner_leases(runner_epoch, status);

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
        RAISE NOTICE 'KHA-73: role % not created; runtime grants skipped', role_name;
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_runner_leases TO kamkm_online_api', schema_name);
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
