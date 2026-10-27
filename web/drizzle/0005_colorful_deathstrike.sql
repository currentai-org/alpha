CREATE TABLE "rag_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"vector" real[] NOT NULL,
	"embedding_model" text NOT NULL,
	"dim" integer NOT NULL,
	"content_hash" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_document_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"action" text NOT NULL,
	"by_user" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_status" text,
	"to_status" text,
	"snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE "rag_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"source" text NOT NULL,
	"source_type" text,
	"source_date" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_document_id_rag_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rag_chunks_doc_chunk_idx" ON "rag_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "rag_chunks_content_hash_idx" ON "rag_chunks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "rag_chunks_active_model_idx" ON "rag_chunks" USING btree ("embedding_model") WHERE active;--> statement-breakpoint
CREATE INDEX "rag_document_audit_document_idx" ON "rag_document_audit" USING btree ("document_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rag_documents_status_updated_idx" ON "rag_documents" USING btree ("status","updated_at" DESC NULLS LAST);