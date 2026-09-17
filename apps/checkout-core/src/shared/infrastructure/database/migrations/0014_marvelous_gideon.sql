CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"consumer" text NOT NULL,
	"message_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbox_consumer_message" ON "inbox" USING btree ("consumer","message_id");