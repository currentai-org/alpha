CREATE TABLE "upload_chunks" (
	"owner_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"idx" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_chunks_owner_id_upload_id_idx_pk" PRIMARY KEY("owner_id","upload_id","idx")
);
--> statement-breakpoint
CREATE INDEX "upload_chunks_created_idx" ON "upload_chunks" USING btree ("created_at");