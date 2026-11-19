-- Idempotent on purpose: an earlier push of this PR applied the same table as a migration numbered
-- 0040, so a database that ran that build already has it. IF NOT EXISTS lets 0041 finish there and
-- is a no-op difference everywhere else.
CREATE TABLE IF NOT EXISTS "shared_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shared_conversations" ADD CONSTRAINT "shared_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shared_conversations" ADD CONSTRAINT "shared_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_conversations_conversation_idx" ON "shared_conversations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_conversations_user_created_idx" ON "shared_conversations" USING btree ("user_id","created_at" DESC NULLS LAST);
