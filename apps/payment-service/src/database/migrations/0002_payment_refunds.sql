CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."payment_order_status" ADD VALUE 'REFUNDING';--> statement-breakpoint
ALTER TYPE "public"."payment_order_status" ADD VALUE 'REFUNDED';--> statement-breakpoint
ALTER TYPE "public"."payment_order_status" ADD VALUE 'REFUND_FAILED';--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" bigint PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"payment_id" bigint NOT NULL,
	"provider_refund_id" text,
	"covered_refund_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"requested_by" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "refund_status" DEFAULT 'PENDING' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_refunds_id_routable" CHECK ("payment_refunds"."id" >= 262144),
	CONSTRAINT "ck_payment_refunds_order_id_routable" CHECK ("payment_refunds"."order_id" >= 262144),
	CONSTRAINT "ck_payment_refunds_requested_by_routable" CHECK ("payment_refunds"."requested_by" >= 262144),
	CONSTRAINT "ck_payment_refunds_amount_positive" CHECK ("payment_refunds"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_refunds_order" ON "payment_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_refunds_provider_refund" ON "payment_refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE INDEX "idx_payments_provider_intent" ON "payments" USING btree ("provider_intent_id");