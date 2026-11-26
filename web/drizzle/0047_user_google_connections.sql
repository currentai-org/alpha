CREATE TABLE "user_google_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"scopes" text NOT NULL,
	"credential" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_google_connections" ADD CONSTRAINT "user_google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;