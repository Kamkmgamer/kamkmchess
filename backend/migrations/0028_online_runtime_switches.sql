-- Schema version 28. The site owner's runtime switches of the online surfaces.
-- Additive only.
--
-- ONLINE_FRIEND_ENABLED and ONLINE_QUEUE_ENABLED stay the defaults. A row here
-- overrides one of them until the owner sets it back, so the owner can open or
-- close a surface from the site without a redeploy. A missing row means the
-- configured default.

CREATE TABLE IF NOT EXISTS online_runtime_switches (
  surface text PRIMARY KEY CHECK (surface IN ('friends', 'queue')),
  enabled boolean NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
