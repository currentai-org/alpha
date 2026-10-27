DROP INDEX "local_inference_endpoints_email_idx";--> statement-breakpoint
ALTER TABLE "local_inference_endpoints" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "local_inference_endpoints" ADD COLUMN "api_key" text;--> statement-breakpoint
ALTER TABLE "local_inference_endpoints" ADD CONSTRAINT "local_inference_endpoints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_inference_endpoints_user_idx" ON "local_inference_endpoints" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "local_inference_endpoints" DROP COLUMN "email";