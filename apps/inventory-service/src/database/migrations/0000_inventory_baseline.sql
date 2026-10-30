CREATE TYPE "public"."reservation_order_status" AS ENUM('HELD', 'COMMITTED', 'RELEASED', 'FENCED', 'RESTOCKED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'RELEASED', 'COMMITTED', 'RESTOCKED');--> statement-breakpoint
CREATE TABLE "reservation_orders" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"status" "reservation_order_status" NOT NULL,
	"hold_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_reservation_orders_order_id_routable" CHECK ("reservation_orders"."order_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'HELD' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_reservations_id_routable" CHECK ("reservations"."id" >= 262144),
	CONSTRAINT "ck_reservations_order_id_routable" CHECK ("reservations"."order_id" >= 262144),
	CONSTRAINT "ck_reservations_variant_id_routable" CHECK ("reservations"."variant_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" bigint PRIMARY KEY NOT NULL,
	"variant_id" bigint NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_variant_id_unique" UNIQUE("variant_id"),
	CONSTRAINT "ck_stock_levels_id_routable" CHECK ("stock_levels"."id" >= 262144),
	CONSTRAINT "ck_stock_levels_variant_id_routable" CHECK ("stock_levels"."variant_id" >= 262144),
	CONSTRAINT "ck_stock_on_hand_nonneg" CHECK ("stock_levels"."quantity_on_hand" >= 0),
	CONSTRAINT "ck_stock_reserved_nonneg" CHECK ("stock_levels"."quantity_reserved" >= 0),
	CONSTRAINT "ck_stock_no_oversell" CHECK ("stock_levels"."quantity_reserved" <= "stock_levels"."quantity_on_hand")
);
--> statement-breakpoint
CREATE INDEX "idx_reservation_orders_held_hold_until" ON "reservation_orders" USING btree ("hold_until") WHERE "reservation_orders"."status" = 'HELD';--> statement-breakpoint
CREATE INDEX "idx_reservations_variant_status" ON "reservations" USING btree ("variant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reservations_order_variant" ON "reservations" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE INDEX "idx_reservations_held_expires_at" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'HELD';