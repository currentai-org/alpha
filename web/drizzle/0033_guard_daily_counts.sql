CREATE TABLE "guard_daily_counts" (
	"day" date NOT NULL,
	"rule_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guard_daily_counts_day_rule_key_pk" PRIMARY KEY("day","rule_key")
);
