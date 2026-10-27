ALTER TABLE "storage_preferences" ADD COLUMN "last_used_location" text;--> statement-breakpoint
-- CUR-3077: before this migration a null default_location was an explicit Alpha storage choice; it now means "Last used", so existing rows keep their choice as "alpha".
UPDATE "storage_preferences" SET "default_location" = 'alpha' WHERE "default_location" IS NULL;