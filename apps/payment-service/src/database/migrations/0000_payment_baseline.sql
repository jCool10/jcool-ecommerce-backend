CREATE TYPE "public"."payment_order_status" AS ENUM('OPEN', 'AUTHORIZED', 'CAPTURED', 'CANCELLED', 'FENCED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'AUTHORIZED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('RECEIVED', 'PROCESSED', 'SKIPPED', 'FAILED');--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"traceparent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "ck_outbox_id_routable" CHECK ("outbox"."id" >= 262144),
	CONSTRAINT "ck_outbox_aggregate_id_routable" CHECK ("outbox"."aggregate_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"status" "payment_order_status" NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"authorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_orders_order_id_routable" CHECK ("payment_orders"."order_id" >= 262144),
	CONSTRAINT "ck_payment_orders_amount_when_not_fenced" CHECK ("payment_orders"."status" = 'FENCED' or ("payment_orders"."amount_minor" is not null and "payment_orders"."currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"provider_intent_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"stripe_key_gen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payments_id_routable" CHECK ("payments"."id" >= 262144),
	CONSTRAINT "ck_payments_order_id_routable" CHECK ("payments"."order_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigint PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "ck_webhook_events_id_routable" CHECK ("webhook_events"."id" >= 262144)
);
--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "idx_outbox_published" ON "outbox" USING btree ("published_at") WHERE "outbox"."published_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_payments_order" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_one_active_per_order" ON "payments" USING btree ("order_id") WHERE "payments"."status" not in ('FAILED', 'EXPIRED');--> statement-breakpoint
CREATE INDEX "idx_payments_status_updated_at" ON "payments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_provider_event" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_events_received" ON "webhook_events" USING btree ("received_at");