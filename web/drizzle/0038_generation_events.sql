CREATE TABLE "generation_events" (
	"generation_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_events_generation_id_seq_pk" PRIMARY KEY("generation_id","seq")
);
--> statement-breakpoint
CREATE INDEX "generation_events_conversation_idx" ON "generation_events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "generation_events_created_idx" ON "generation_events" USING btree ("created_at");