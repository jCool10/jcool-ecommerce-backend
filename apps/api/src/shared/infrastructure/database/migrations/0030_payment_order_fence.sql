CREATE TYPE "public"."payment_order_status" AS ENUM('OPEN', 'AUTHORIZED', 'CAPTURED', 'CANCELLED', 'FENCED');--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'AUTHORIZED';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'VOIDED';--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"status" "payment_order_status" NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_orders_order_id_routable" CHECK ("payment_orders"."order_id" >= 262144),
	CONSTRAINT "ck_payment_orders_amount_when_not_fenced" CHECK ("payment_orders"."status" = 'FENCED' OR ("payment_orders"."amount_minor" IS NOT NULL AND "payment_orders"."currency" IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "uq_payments_one_active_per_order";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_key_gen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "authorized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_payments_unsettled_updated" ON "payments" USING btree ("updated_at") WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_one_active_per_order" ON "payments" USING btree ("order_id") WHERE status NOT IN ('FAILED', 'EXPIRED');