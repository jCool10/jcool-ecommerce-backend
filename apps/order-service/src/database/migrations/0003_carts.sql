CREATE TABLE "cart_items" (
	"id" bigint PRIMARY KEY NOT NULL,
	"cart_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_cart_items_id_routable" CHECK ("cart_items"."id" >= 262144),
	CONSTRAINT "ck_cart_items_cart_id_routable" CHECK ("cart_items"."cart_id" >= 262144),
	CONSTRAINT "ck_cart_items_sku_id_routable" CHECK ("cart_items"."sku_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "ck_carts_id_routable" CHECK ("carts"."id" >= 262144),
	CONSTRAINT "ck_carts_user_id_routable" CHECK ("carts"."user_id" >= 262144)
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cart_items_cart_sku" ON "cart_items" USING btree ("cart_id","sku_id");