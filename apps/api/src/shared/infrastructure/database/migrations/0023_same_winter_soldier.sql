ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_user_id_routable" CHECK ("carts"."user_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_user_id_routable" CHECK ("orders"."user_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "ck_media_assets_uploaded_by_routable" CHECK ("media_assets"."uploaded_by" >= 4194304);