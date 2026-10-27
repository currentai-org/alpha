CREATE TABLE "local_inference_pairings" (
	"pairing_id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint_id" text,
	"credentials" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_inference_pairings" ADD CONSTRAINT "local_inference_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_inference_pairings" ADD CONSTRAINT "local_inference_pairings_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."local_inference_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_inference_pairings_user_idx" ON "local_inference_pairings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_inference_pairings_expires_idx" ON "local_inference_pairings" USING btree ("expires_at");