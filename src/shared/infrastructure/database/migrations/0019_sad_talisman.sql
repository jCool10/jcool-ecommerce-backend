CREATE TYPE "public"."media_asset_status" AS ENUM('PENDING', 'READY', 'ATTACHED', 'DETACHED', 'SWEEPING');--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"alt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"status" "media_asset_status" DEFAULT 'PENDING' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_product_images_product_position" ON "product_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_images_product_asset" ON "product_images" USING btree ("product_id","asset_id");--> statement-breakpoint
CREATE INDEX "idx_media_assets_reclaimable_expires_at" ON "media_assets" USING btree ("expires_at") WHERE "media_assets"."status" in ('PENDING', 'READY', 'DETACHED');--> statement-breakpoint
CREATE INDEX "idx_media_assets_sweeping_updated_at" ON "media_assets" USING btree ("updated_at") WHERE "media_assets"."status" = 'SWEEPING';