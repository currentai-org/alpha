-- IF NOT EXISTS throughout: `contributions` drifted into schema.ts without a migration, so an
-- already-deployed DB built via `drizzle-kit push` may already have it. This keeps the migrate path
-- valid for a fresh DB while staying safe to apply on a push-built one.
CREATE TABLE IF NOT EXISTS "contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"organization" text,
	"contribution_type" text,
	"detail" text,
	"user_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contributions_ip_created_idx" ON "contributions" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_updated_idx" ON "conversations" USING btree ("updated_at");