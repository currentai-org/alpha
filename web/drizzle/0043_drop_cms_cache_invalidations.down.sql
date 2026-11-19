-- Down for 0043_drop_cms_cache_invalidations.sql. drizzle-kit has no down runner, so this file is run
-- by hand (psql) and its journal row removed with it. It recreates the empty table 0011 made; no code
-- reads it, so recreating it brings back no behaviour on its own.
CREATE TABLE IF NOT EXISTS "cms_cache_invalidations" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_prefix" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "cms_cache_invalidations_created_idx" ON "cms_cache_invalidations" USING btree ("created_at");
