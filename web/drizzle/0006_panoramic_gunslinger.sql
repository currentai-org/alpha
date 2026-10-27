ALTER TABLE "reports" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "category" text;