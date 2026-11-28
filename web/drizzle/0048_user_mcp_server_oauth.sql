ALTER TABLE "user_mcp_servers" ADD COLUMN "auth_kind" text DEFAULT 'bearer' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mcp_servers" ADD COLUMN "oauth_state" text;--> statement-breakpoint
ALTER TABLE "user_mcp_servers" ADD COLUMN "needs_reconnect" boolean DEFAULT false NOT NULL;