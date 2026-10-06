CREATE TYPE "public"."reservation_order_status" AS ENUM('HELD', 'COMMITTED', 'RELEASED', 'FENCED', 'RESTOCKED');--> statement-breakpoint
ALTER TYPE "public"."reservation_status" ADD VALUE 'RESTOCKED';--> statement-breakpoint
CREATE TABLE "reservation_orders" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"status" "reservation_order_status" NOT NULL,
	"hold_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_reservation_orders_order_id_routable" CHECK ("reservation_orders"."order_id" >= 262144)
);
--> statement-breakpoint
CREATE INDEX "idx_reservation_orders_held_hold_until" ON "reservation_orders" USING btree ("hold_until") WHERE "reservation_orders"."status" = 'HELD';