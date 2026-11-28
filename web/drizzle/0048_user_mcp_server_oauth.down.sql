-- Down for 0048_user_mcp_server_oauth.sql. drizzle-kit has no down runner, so this file is run by hand
-- (psql) and its journal row removed with it. Drops every OAuth MCP server's sealed client and tokens;
-- delete those rows first, since without auth_kind they would read as bearer servers with no token.
ALTER TABLE "user_mcp_servers" DROP COLUMN IF EXISTS "needs_reconnect";
ALTER TABLE "user_mcp_servers" DROP COLUMN IF EXISTS "oauth_state";
ALTER TABLE "user_mcp_servers" DROP COLUMN IF EXISTS "auth_kind";
