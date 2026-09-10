CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"traceparent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;