-- Down for 0046_safety_events_evidence.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. Drops the evidence paths; the quarantined objects stay.
ALTER TABLE "safety_events" DROP COLUMN IF EXISTS "evidence";
