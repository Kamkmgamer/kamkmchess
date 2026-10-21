-- The durable order of the checkpoints of a dependency.
--
-- The shared state of a dependency is the newest checkpoint of that
-- dependency, so the checkpoints need an order that does not depend on a
-- clock. The recorded_at of a checkpoint keeps the moment of the write for
-- the history, and the observation_order is the order of the observations:
-- the sequence is allocated by the database, so the newest checkpoint is the
-- one with the greatest order, whatever the clock of the host or of the
-- database did.
--
-- The order is allocated before the commit, so a write that completes after
-- a newer one does not become the newest checkpoint: the shared read takes
-- the greatest order, and a write with a smaller order is history.

CREATE SEQUENCE IF NOT EXISTS online_service_health_order;

ALTER TABLE online_service_health ADD COLUMN IF NOT EXISTS observation_order bigint;

CREATE INDEX IF NOT EXISTS online_service_health_newest
  ON online_service_health(dependency, observation_order DESC);
