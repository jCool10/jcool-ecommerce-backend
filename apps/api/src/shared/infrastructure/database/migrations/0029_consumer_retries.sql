CREATE TYPE "public"."consumer_retry_status" AS ENUM('pending', 'dead');--> statement-breakpoint
CREATE TABLE "consumer_retries" (
	"consumer" text NOT NULL,
	"message_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"attempts_made" integer NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"status" "consumer_retry_status" NOT NULL,
	"dead_reason" text,
	"last_error" text NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_consumer_retries" PRIMARY KEY("consumer","message_id"),
	CONSTRAINT "ck_consumer_retries_message_id_routable" CHECK ("consumer_retries"."message_id" >= 262144)
);
--> statement-breakpoint
CREATE INDEX "idx_consumer_retries_due" ON "consumer_retries" USING btree ("next_attempt_at") WHERE "consumer_retries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_consumer_retries_dead" ON "consumer_retries" USING btree ("created_at") WHERE "consumer_retries"."status" = 'dead';