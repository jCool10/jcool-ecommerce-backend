-- Every id column now holds an id the id service mints, a 63-bit integer rather than a uuid.
--
-- A uuid has no bigint form, so every api table is emptied first and each column converts through
-- `USING NULL`, which only an empty table accepts. Every catalog, cart, order, payment, media and
-- messaging row is gone after this. The foreign keys come off around the change because a key and
-- the column it references cannot change type in separate statements.
TRUNCATE TABLE "categories", "products", "product_variants", "prices", "product_images", "carts", "cart_items", "orders", "order_items", "idempotency_keys", "reservations", "stock_levels", "payments", "webhook_events", "media_assets", "outbox", "inbox";--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT "prices_variant_id_product_variants_id_fk";--> statement-breakpoint
ALTER TABLE "product_images" DROP CONSTRAINT "product_images_product_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "cart_items" DROP CONSTRAINT "cart_items_cart_id_carts_id_fk";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "parent_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "prices" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "prices" ALTER COLUMN "variant_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "product_images" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "product_images" ALTER COLUMN "product_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "product_images" ALTER COLUMN "asset_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "product_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "category_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "cart_items" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "cart_items" ALTER COLUMN "cart_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "cart_items" ALTER COLUMN "sku_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "carts" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "order_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "sku_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "order_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "order_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "variant_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "stock_levels" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "stock_levels" ALTER COLUMN "variant_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "outbox" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "outbox" ALTER COLUMN "aggregate_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "inbox" ALTER COLUMN "id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "inbox" ALTER COLUMN "message_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_id_routable" CHECK ("categories"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_parent_id_routable" CHECK ("categories"."parent_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "ck_prices_id_routable" CHECK ("prices"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "ck_prices_variant_id_routable" CHECK ("prices"."variant_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_id_routable" CHECK ("product_images"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_product_id_routable" CHECK ("product_images"."product_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_asset_id_routable" CHECK ("product_images"."asset_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "ck_product_variants_id_routable" CHECK ("product_variants"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "ck_product_variants_product_id_routable" CHECK ("product_variants"."product_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_id_routable" CHECK ("products"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_category_id_routable" CHECK ("products"."category_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_id_routable" CHECK ("cart_items"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_cart_id_routable" CHECK ("cart_items"."cart_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_sku_id_routable" CHECK ("cart_items"."sku_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_id_routable" CHECK ("carts"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_id_routable" CHECK ("order_items"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_order_id_routable" CHECK ("order_items"."order_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_sku_id_routable" CHECK ("order_items"."sku_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_id_routable" CHECK ("orders"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "ck_idempotency_keys_id_routable" CHECK ("idempotency_keys"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "ck_idempotency_keys_order_id_routable" CHECK ("idempotency_keys"."order_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_id_routable" CHECK ("reservations"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_order_id_routable" CHECK ("reservations"."order_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_variant_id_routable" CHECK ("reservations"."variant_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "ck_stock_levels_id_routable" CHECK ("stock_levels"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "ck_stock_levels_variant_id_routable" CHECK ("stock_levels"."variant_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_id_routable" CHECK ("payments"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_order_id_routable" CHECK ("payments"."order_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "ck_webhook_events_id_routable" CHECK ("webhook_events"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "ck_media_assets_id_routable" CHECK ("media_assets"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "ck_outbox_id_routable" CHECK ("outbox"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "ck_outbox_aggregate_id_routable" CHECK ("outbox"."aggregate_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "ck_inbox_id_routable" CHECK ("inbox"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "ck_inbox_message_id_routable" CHECK ("inbox"."message_id" >= 4194304);
