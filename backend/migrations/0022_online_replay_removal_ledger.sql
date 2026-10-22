-- KHA-79: the durable ledger of the per match removal of a public replay.
--
-- The per match removal of a public replay (remove_public_replay) revokes the
-- published replay of one match. It is not a removal of a participant: the
-- participant keeps its seat, its history and its other games. The row
-- therefore names no subject and no removal request, and it names the match,
-- the marker of the removal and the time of the removal.
--
-- The row is the durable record that a restore of an older backup replays
-- before the restored database serves traffic. Without it, a bundle that was
-- sealed before the removal would restore the public replay of the match and
-- the removed content would be served again.
--
-- The row never stores the removed content, a credential, a session, a
-- provider request or a private endpoint. It stores the identifier of a match,
-- which is not the identifier of a person.

CREATE TABLE IF NOT EXISTS online_replay_removal_ledger (
  ledger_id text PRIMARY KEY CHECK (ledger_id ~ '^rr_[A-Za-z0-9_-]{8,63}$'),
  -- The match whose public replay was removed.
  match_id text NOT NULL UNIQUE CHECK (length(match_id) BETWEEN 8 AND 64),
  -- The deletion marker of the removal. The marker is the record that the
  -- public replay of the match must not be served again.
  marker_id text NOT NULL CHECK (length(marker_id) BETWEEN 1 AND 128),
  -- The reason the participant gave for the removal.
  reason text NOT NULL CHECK (reason IN ('owner_request', 'erasure_request', 'account_deletion')),
  removed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS online_replay_removal_ledger_match ON online_replay_removal_ledger(match_id);

-- The ledger entry is durable: it is never rewritten and never deleted.
CREATE OR REPLACE FUNCTION online_guard_replay_removal_record_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'online replay removal record is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS online_replay_removal_ledger_guard ON online_replay_removal_ledger;
CREATE TRIGGER online_replay_removal_ledger_guard BEFORE UPDATE ON online_replay_removal_ledger
  FOR EACH ROW EXECUTE FUNCTION online_guard_replay_removal_record_update();

DROP TRIGGER IF EXISTS online_replay_removal_ledger_immutable_delete ON online_replay_removal_ledger;
CREATE TRIGGER online_replay_removal_ledger_immutable_delete BEFORE DELETE ON online_replay_removal_ledger
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants follow the KHA-65 pattern. The API role reads and appends the
-- ledger, the private rules process keeps no table privileges at all.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.online_replay_removal_ledger TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_replay_removal_ledger FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_replay_removal_ledger FROM PUBLIC;
