ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_archived_pinned_updated_idx" ON "conversations" USING btree ("user_id","archived","pinned" DESC NULLS LAST,"updated_at" DESC NULLS LAST);
