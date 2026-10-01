-- Layout 2 ships as a reset. A layout-1 id still passes the new floor but decodes into other fields,
-- and nothing else here would notice the two layouts mixing.
DO $$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['cart_items', 'carts', 'categories', 'idempotency_keys', 'inbox', 'media_assets', 'order_items', 'orders', 'outbox', 'payments', 'prices', 'product_images', 'product_variants', 'products', 'reservations', 'stock_levels', 'webhook_events'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', t) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'id layout 2 needs a reset database: table % is not empty', t;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "ck_categories_id_routable";--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "ck_categories_parent_id_routable";--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT "ck_prices_id_routable";--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT "ck_prices_variant_id_routable";--> statement-breakpoint
ALTER TABLE "product_images" DROP CONSTRAINT "ck_product_images_id_routable";--> statement-breakpoint
ALTER TABLE "product_images" DROP CONSTRAINT "ck_product_images_product_id_routable";--> statement-breakpoint
ALTER TABLE "product_images" DROP CONSTRAINT "ck_product_images_asset_id_routable";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "ck_product_variants_id_routable";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "ck_product_variants_product_id_routable";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "ck_products_id_routable";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "ck_products_category_id_routable";--> statement-breakpoint
ALTER TABLE "cart_items" DROP CONSTRAINT "ck_cart_items_id_routable";--> statement-breakpoint
ALTER TABLE "cart_items" DROP CONSTRAINT "ck_cart_items_cart_id_routable";--> statement-breakpoint
ALTER TABLE "cart_items" DROP CONSTRAINT "ck_cart_items_sku_id_routable";--> statement-breakpoint
ALTER TABLE "carts" DROP CONSTRAINT "ck_carts_id_routable";--> statement-breakpoint
ALTER TABLE "carts" DROP CONSTRAINT "ck_carts_user_id_routable";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "ck_order_items_id_routable";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "ck_order_items_order_id_routable";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "ck_order_items_sku_id_routable";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_id_routable";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_user_id_routable";--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "ck_idempotency_keys_id_routable";--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "ck_idempotency_keys_order_id_routable";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "ck_reservations_id_routable";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "ck_reservations_order_id_routable";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "ck_reservations_variant_id_routable";--> statement-breakpoint
ALTER TABLE "stock_levels" DROP CONSTRAINT "ck_stock_levels_id_routable";--> statement-breakpoint
ALTER TABLE "stock_levels" DROP CONSTRAINT "ck_stock_levels_variant_id_routable";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_id_routable";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_order_id_routable";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "ck_webhook_events_id_routable";--> statement-breakpoint
ALTER TABLE "media_assets" DROP CONSTRAINT "ck_media_assets_id_routable";--> statement-breakpoint
ALTER TABLE "media_assets" DROP CONSTRAINT "ck_media_assets_uploaded_by_routable";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "ck_outbox_id_routable";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "ck_outbox_aggregate_id_routable";--> statement-breakpoint
ALTER TABLE "inbox" DROP CONSTRAINT "ck_inbox_id_routable";--> statement-breakpoint
ALTER TABLE "inbox" DROP CONSTRAINT "ck_inbox_message_id_routable";--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_id_routable" CHECK ("categories"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_parent_id_routable" CHECK ("categories"."parent_id" >= 262144);--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "ck_prices_id_routable" CHECK ("prices"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "ck_prices_variant_id_routable" CHECK ("prices"."variant_id" >= 262144);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_id_routable" CHECK ("product_images"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_product_id_routable" CHECK ("product_images"."product_id" >= 262144);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "ck_product_images_asset_id_routable" CHECK ("product_images"."asset_id" >= 262144);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "ck_product_variants_id_routable" CHECK ("product_variants"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "ck_product_variants_product_id_routable" CHECK ("product_variants"."product_id" >= 262144);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_id_routable" CHECK ("products"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_category_id_routable" CHECK ("products"."category_id" >= 262144);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_id_routable" CHECK ("cart_items"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_cart_id_routable" CHECK ("cart_items"."cart_id" >= 262144);--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_sku_id_routable" CHECK ("cart_items"."sku_id" >= 262144);--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_id_routable" CHECK ("carts"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_user_id_routable" CHECK ("carts"."user_id" >= 262144);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_id_routable" CHECK ("order_items"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_order_id_routable" CHECK ("order_items"."order_id" >= 262144);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_sku_id_routable" CHECK ("order_items"."sku_id" >= 262144);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_id_routable" CHECK ("orders"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_user_id_routable" CHECK ("orders"."user_id" >= 262144);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "ck_idempotency_keys_id_routable" CHECK ("idempotency_keys"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "ck_idempotency_keys_order_id_routable" CHECK ("idempotency_keys"."order_id" >= 262144);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_id_routable" CHECK ("reservations"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_order_id_routable" CHECK ("reservations"."order_id" >= 262144);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "ck_reservations_variant_id_routable" CHECK ("reservations"."variant_id" >= 262144);--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "ck_stock_levels_id_routable" CHECK ("stock_levels"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "ck_stock_levels_variant_id_routable" CHECK ("stock_levels"."variant_id" >= 262144);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_id_routable" CHECK ("payments"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_order_id_routable" CHECK ("payments"."order_id" >= 262144);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "ck_webhook_events_id_routable" CHECK ("webhook_events"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "ck_media_assets_id_routable" CHECK ("media_assets"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "ck_media_assets_uploaded_by_routable" CHECK ("media_assets"."uploaded_by" >= 262144);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "ck_outbox_id_routable" CHECK ("outbox"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "ck_outbox_aggregate_id_routable" CHECK ("outbox"."aggregate_id" >= 262144);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "ck_inbox_id_routable" CHECK ("inbox"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "ck_inbox_message_id_routable" CHECK ("inbox"."message_id" >= 262144);