CREATE TABLE "mcp_elicitations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mcp_elicitations_conversation_idx" ON "mcp_elicitations" USING btree ("conversation_id");