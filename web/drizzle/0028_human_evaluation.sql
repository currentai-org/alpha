CREATE TABLE IF NOT EXISTS "human_eval_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"language" text NOT NULL,
	"level" text NOT NULL,
	"variety" text,
	"consent_version" text NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_checks" integer DEFAULT 0 NOT NULL,
	"calibration_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_eval_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"language" text NOT NULL,
	"task_id" text NOT NULL,
	"model_id" text NOT NULL,
	"declared_level" text NOT NULL,
	"rubric_version" text NOT NULL,
	"task_set_version" text NOT NULL,
	"scores" jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment" text,
	"duration_ms" integer NOT NULL,
	"validity" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_set_version" text NOT NULL,
	"task_id" text NOT NULL,
	"language" text NOT NULL,
	"model_id" text NOT NULL,
	"model_revision" text,
	"provider" text,
	"served_model" text,
	"app_build" text,
	"generation_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt" text NOT NULL,
	"response" text NOT NULL,
	"auto_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_check" boolean DEFAULT false NOT NULL,
	"check_source_language" text,
	"current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "human_eval_profiles" ADD CONSTRAINT "human_eval_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "human_eval_ratings" ADD CONSTRAINT "human_eval_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "human_eval_ratings" ADD CONSTRAINT "human_eval_ratings_run_id_human_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."human_eval_runs"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "human_eval_profiles_user_lang_idx" ON "human_eval_profiles" USING btree ("user_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "human_eval_ratings_user_run_idx" ON "human_eval_ratings" USING btree ("user_id","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_eval_ratings_run_idx" ON "human_eval_ratings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_eval_ratings_lang_model_idx" ON "human_eval_ratings" USING btree ("language","model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_eval_ratings_user_created_idx" ON "human_eval_ratings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_eval_runs_lang_current_idx" ON "human_eval_runs" USING btree ("language","current","task_set_version");