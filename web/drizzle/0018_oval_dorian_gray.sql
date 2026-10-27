CREATE TABLE "local_inference_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_inference_endpoints_email_idx" ON "local_inference_endpoints" USING btree ("email");