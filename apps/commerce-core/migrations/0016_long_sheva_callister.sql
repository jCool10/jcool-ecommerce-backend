-- Hand-added: drizzle-kit emits the GIN index but never the extension it needs.
-- Needs superuser (or rds_superuser); a managed role without it fails here and, since the runner
-- wraps this file in a transaction, takes the three index creations down with it. Provision the
-- extension out-of-band on such a database before deploying.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_products_active_created" ON "products" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "products"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "idx_products_category_active_created" ON "products" USING btree ("category_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "products"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "idx_products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops);