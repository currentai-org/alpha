ALTER TABLE "organization" ADD COLUMN "join_method" text DEFAULT 'invitation' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "config_change_rule" text DEFAULT 'admin_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "rules_visibility" text DEFAULT 'always' NOT NULL;