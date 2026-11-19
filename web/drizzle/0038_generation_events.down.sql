-- Down for 0038_generation_events.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. The table holds only stream-follow's short-lived copy
-- of answers while they stream; dropping it loses no saved conversation, and a follow
-- in progress falls back to the saved copy.
DROP INDEX IF EXISTS "generation_events_created_idx";
DROP INDEX IF EXISTS "generation_events_conversation_idx";
DROP TABLE IF EXISTS "generation_events";
