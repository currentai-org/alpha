ALTER TABLE "reports" ADD COLUMN "status" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "status_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_session_idx" ON "reports" USING btree ("session_id");