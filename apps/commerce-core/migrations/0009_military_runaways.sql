CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('RECEIVED', 'PROCESSED', 'SKIPPED', 'FAILED');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"provider_intent_id" text,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_payments_order" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_provider_event" ON "webhook_events" USING btree ("provider","provider_event_id");