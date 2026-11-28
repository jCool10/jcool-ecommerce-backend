CREATE TABLE "catalog_sku_views" (
	"sku_id" bigint PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"product_name" text NOT NULL,
	"unit_price_minor" integer,
	"currency" text NOT NULL,
	"is_active" boolean NOT NULL,
	"product_version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_catalog_sku_views_sku_id_routable" CHECK ("catalog_sku_views"."sku_id" >= 262144),
	CONSTRAINT "ck_catalog_sku_views_product_id_routable" CHECK ("catalog_sku_views"."product_id" >= 262144),
	CONSTRAINT "ck_catalog_sku_views_price_positive" CHECK ("catalog_sku_views"."unit_price_minor" > 0),
	CONSTRAINT "ck_catalog_sku_views_currency_vnd" CHECK ("catalog_sku_views"."currency" = 'VND')
);
