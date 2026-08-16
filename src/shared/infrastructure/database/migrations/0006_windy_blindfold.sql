CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'RELEASED', 'COMMITTED');--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'HELD' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_variant_id_unique" UNIQUE("variant_id"),
	CONSTRAINT "ck_stock_on_hand_nonneg" CHECK ("stock_levels"."quantity_on_hand" >= 0),
	CONSTRAINT "ck_stock_reserved_nonneg" CHECK ("stock_levels"."quantity_reserved" >= 0),
	CONSTRAINT "ck_stock_no_oversell" CHECK ("stock_levels"."quantity_reserved" <= "stock_levels"."quantity_on_hand")
);
--> statement-breakpoint
CREATE INDEX "idx_reservations_variant_status" ON "reservations" USING btree ("variant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reservations_order_variant" ON "reservations" USING btree ("order_id","variant_id");