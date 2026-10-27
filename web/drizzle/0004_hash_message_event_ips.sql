-- Privacy: stop storing raw client IPs on `message_events` (the per-IP rate-limit + global-daily-cap
-- rows). Going forward the app writes only a keyed, domain-separated HMAC of the IP (see
-- src/lib/server/db/ipHash.ts, domain "rate-limit"); this migration renames the column to its honest
-- name and PURGES any raw IPs captured before hashing was in place.
ALTER TABLE "message_events" RENAME COLUMN "ip" TO "ip_hash";--> statement-breakpoint
-- Purge pre-hashing raw IPs: they are personal data, and these rows live at most 24h (expires_at),
-- so historical values are both stale and unnecessary. NULL them rather than keep PII at rest.
UPDATE "message_events" SET "ip_hash" = NULL WHERE "ip_hash" IS NOT NULL;--> statement-breakpoint
-- The btree index follows the renamed column automatically (Postgres); rename it to match so the
-- index name stays honest too.
ALTER INDEX IF EXISTS "message_events_ip_idx" RENAME TO "message_events_ip_hash_idx";
