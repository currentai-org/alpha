ALTER TABLE "turn_outcomes" ADD COLUMN IF NOT EXISTS "failure_layer" text;--> statement-breakpoint
ALTER TABLE "turn_outcomes" ADD COLUMN IF NOT EXISTS "model" text;