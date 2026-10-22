-- KHA-71 follow-up schema version 25. Persisted operator restart plans.
--
-- PlanSuspension records an operator-announced restart separately from a
-- dependency suspension and an interruption discovered on recovery. The
-- boundary table predates that distinction and originally accepted only the
-- latter two kinds, so extend its check constraint for existing databases.

ALTER TABLE online_suspension_boundaries
  DROP CONSTRAINT IF EXISTS online_suspension_boundaries_kind_check;
ALTER TABLE online_suspension_boundaries
  ADD CONSTRAINT online_suspension_boundaries_kind_check
  CHECK (kind IN ('planned', 'restart', 'unexpected'));
