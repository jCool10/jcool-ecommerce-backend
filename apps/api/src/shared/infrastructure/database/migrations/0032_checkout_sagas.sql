CREATE TYPE "public"."checkout_saga_step" AS ENUM('RESERVING', 'AWAITING_AUTH', 'COMMITTING_STOCK', 'CAPTURING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED');--> statement-breakpoint
CREATE TABLE "checkout_sagas" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"step" "checkout_saga_step" NOT NULL,
	"pending_compensations" text[] DEFAULT '{}'::text[] NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_checkout_sagas_order_id_routable" CHECK ("checkout_sagas"."order_id" >= 262144)
);
--> statement-breakpoint
DROP INDEX "idx_orders_pending_placed_at";--> statement-breakpoint
ALTER TABLE "checkout_sagas" ADD CONSTRAINT "checkout_sagas_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_checkout_sagas_due" ON "checkout_sagas" USING btree ("next_attempt_at") WHERE "checkout_sagas"."step" NOT IN ('COMPLETED', 'COMPENSATED');