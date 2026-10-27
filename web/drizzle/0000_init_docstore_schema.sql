CREATE TABLE "aborted_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"conversation_id" text,
	"mime" text,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"ip" text,
	"type" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"user_id" text,
	"session_id" text,
	"reason" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semaphores" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"updated_at" timestamp with time zone,
	"delete_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"session_id" text,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_caches" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text,
	"user_id" text,
	"created_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"hf_user_id" text,
	"username" text,
	"created_at" timestamp with time zone,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aborted_generations_conversation_idx" ON "aborted_generations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_session_updated_idx" ON "conversations" USING btree ("session_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "files_filename_idx" ON "files" USING btree ("filename");--> statement-breakpoint
CREATE INDEX "message_events_user_idx" ON "message_events" USING btree ("user_id","type","expires_at");--> statement-breakpoint
CREATE INDEX "message_events_ip_idx" ON "message_events" USING btree ("ip","type","expires_at");--> statement-breakpoint
CREATE INDEX "reports_conversation_idx" ON "reports" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "semaphores_key_idx" ON "semaphores" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_session_id_idx" ON "sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_user_idx" ON "settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_session_idx" ON "settings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "token_caches_hash_idx" ON "token_caches" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_hf_user_id_idx" ON "users" USING btree ("hf_user_id");--> statement-breakpoint
CREATE INDEX "users_username_idx" ON "users" USING btree ("username");