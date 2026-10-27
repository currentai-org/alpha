ALTER TABLE "local_inference_endpoints" ADD COLUMN "headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "local_inference_endpoints" DROP COLUMN "api_key";