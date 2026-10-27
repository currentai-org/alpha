CREATE TABLE "cms_cache_invalidations" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_prefix" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cms_cache_invalidations_created_idx" ON "cms_cache_invalidations" USING btree ("created_at");