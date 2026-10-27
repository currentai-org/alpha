CREATE TABLE "alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"firing" boolean DEFAULT false NOT NULL,
	"last_fired_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
