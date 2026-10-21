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
-- The existing rows are backfilled by their recorded_at and their identity,
-- so the newest of them stays the newest, and the sequence continues above
-- the backfilled orders. The column is not nullable: a checkpoint without an
-- order would sort before every ordered checkpoint and would be read as the
-- newest one for ever.

CREATE SEQUENCE IF NOT EXISTS online_service_health_order;

ALTER TABLE online_service_health ADD COLUMN IF NOT EXISTS observation_order bigint;

-- The backfill of the rows that existed before the order existed. The order
-- follows the recorded_at and the identity, so it is the order in which the
-- checkpoints were written.
WITH backfill AS (
  SELECT checkpoint_id, row_number() OVER (ORDER BY recorded_at, checkpoint_id) AS ordinal
  FROM online_service_health
)
UPDATE online_service_health AS checkpoint
SET observation_order = backfill.ordinal
FROM backfill
WHERE checkpoint.checkpoint_id = backfill.checkpoint_id;

-- The sequence continues above the backfilled orders.
SELECT setval('online_service_health_order', COALESCE((SELECT max(observation_order) FROM online_service_health), 0) + 1, false);

ALTER TABLE online_service_health ALTER COLUMN observation_order SET DEFAULT nextval('online_service_health_order');
ALTER TABLE online_service_health ALTER COLUMN observation_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS online_service_health_newest
  ON online_service_health(dependency, observation_order DESC);

-- The sequence is granted by the deployment policy to the role that writes
-- the health of the service. The rules process holds no SQL privilege at all,
-- so it never receives the usage of the sequence.
