-- Down for 0044_safety_events_probe.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. Drops the probe name; the rows stay, unmarked.
ALTER TABLE "safety_events" DROP COLUMN IF EXISTS "probe";
