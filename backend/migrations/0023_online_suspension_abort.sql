-- KHA-71 follow-up schema version 23. The abort of a planned suspension.
--
-- Additive only. Nothing in this file alters, rewrites, or re-grants the
-- private single-owner sync tables from 0001_storage.sql, and no existing
-- shared row is rewritten. The online tables keep no foreign keys into the
-- private archive and never store provider credentials, raw provider
-- requests, AI conversation, private endpoints, or owner archives.
--
-- A planned suspension is persisted before the service stops, so the interval
-- of the interruption is known exactly when the service comes back. A plan
-- that will not happen -- the restart was called off -- has to leave the
-- durable gate open again, and the row of the plan stays the evidence that
-- the plan existed.
--
-- The abort is therefore a column of the boundary and not a deletion of it: an
-- aborted boundary keeps its identity, its interval and its epoch, and the
-- durable gate reads it as a boundary that was never applied. A boundary that
-- is applied is never aborted, because the refund of an applied boundary is
-- the published canonical state of the matches.
ALTER TABLE online_suspension_boundaries
  ADD COLUMN IF NOT EXISTS aborted_at timestamptz;

-- A boundary is either applied or aborted, never both. The adjustment of an
-- applied boundary is the published canonical state of the matches, and an
-- aborted boundary has no adjustment at all.
ALTER TABLE online_suspension_boundaries
  DROP CONSTRAINT IF EXISTS online_suspension_boundaries_aborted_check;
ALTER TABLE online_suspension_boundaries
  ADD CONSTRAINT online_suspension_boundaries_aborted_check
  CHECK (aborted_at IS NULL OR adjusted_at IS NULL);

-- The pending index carries the boundaries that are neither applied nor
-- aborted, so the recovery of a pending plan finds the pending row and an
-- aborted plan never blocks the gate.
DROP INDEX IF EXISTS online_suspension_boundaries_pending;
CREATE INDEX IF NOT EXISTS online_suspension_boundaries_pending
  ON online_suspension_boundaries(adjusted_at)
  WHERE adjusted_at IS NULL AND aborted_at IS NULL;

-- The table level grants of 0008 cover the new column: a grant on a table
-- covers every column of it, including the ones a later migration adds. The
-- runtime role therefore needs no new privilege, and the policy of
-- deploy/runtime-grants.policy.json stays the reviewed least privilege set.
