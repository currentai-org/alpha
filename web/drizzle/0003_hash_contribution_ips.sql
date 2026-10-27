-- Privacy: stop storing raw client IPs on `contributions`. Going forward the app writes only a
-- keyed HMAC of the IP (see src/lib/server/db/ipHash.ts); this migration renames the column to its
-- honest name and PURGES any raw IPs captured before hashing was in place.
ALTER TABLE "contributions" RENAME COLUMN "ip" TO "ip_hash";--> statement-breakpoint
-- Purge pre-hashing raw IPs: they are personal data, and the per-IP cap only ever needs the last
-- 24h, so historical values are both stale and unnecessary. NULL them rather than keep PII at rest.
UPDATE "contributions" SET "ip_hash" = NULL WHERE "ip_hash" IS NOT NULL;--> statement-breakpoint
-- The btree index follows the renamed column automatically (Postgres); rename it to match so the
-- index name stays honest too.
ALTER INDEX IF EXISTS "contributions_ip_created_idx" RENAME TO "contributions_ip_hash_created_idx";
