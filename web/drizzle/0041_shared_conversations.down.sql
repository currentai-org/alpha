-- Down for 0041_shared_conversations.sql. drizzle-kit has no down runner, so this file is run by
-- hand (psql) and its journal row removed with it. Dropping the table ends every share link; the
-- conversations themselves are untouched.
DROP TABLE IF EXISTS "shared_conversations";
