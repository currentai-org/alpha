-- Down for 0047_user_google_connections.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. Drops every connected Google account's sealed refresh token.
DROP TABLE IF EXISTS "user_google_connections";
