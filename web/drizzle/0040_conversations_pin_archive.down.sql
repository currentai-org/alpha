-- Down for 0040_conversations_pin_archive.sql. drizzle-kit has no down runner, so this file is run by
-- hand (psql) and its journal row removed with it. Dropping the columns loses every pin and archive
-- flag; the conversations themselves are untouched.
DROP INDEX IF EXISTS "conversations_user_archived_pinned_updated_idx";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "archived";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "pinned";
