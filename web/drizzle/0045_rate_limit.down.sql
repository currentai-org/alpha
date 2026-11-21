-- Down for 0045_rate_limit.sql. drizzle-kit has no down runner, so this file is run by hand (psql) and
-- its journal row removed with it. Drops Better Auth's rate-limit counters; the code reads the table only
-- when rateLimit.storage is "database", so run this after that code is gone.
DROP TABLE IF EXISTS "rate_limit";
