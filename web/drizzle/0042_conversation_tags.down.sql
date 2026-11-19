-- Down for 0042_conversation_tags.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. Dropping these loses every tag and every chat's tag
-- list; the conversations themselves are untouched.
DROP INDEX IF EXISTS "conversations_tags_idx";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "tags";
DROP TABLE IF EXISTS "conversation_tags";
