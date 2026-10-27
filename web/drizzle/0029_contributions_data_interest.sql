ALTER TABLE "contributions" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN IF NOT EXISTS "language" text;