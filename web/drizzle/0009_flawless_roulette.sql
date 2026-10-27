CREATE TABLE "turn_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"decline_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "turn_outcomes_created_idx" ON "turn_outcomes" USING btree ("created_at");