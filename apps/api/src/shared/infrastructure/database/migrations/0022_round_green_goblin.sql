-- `user_id` and `uploaded_by` now hold an id the id service mints, which is a 63-bit integer rather
-- than a uuid.
--
-- Written as DROP + ADD, not ALTER TYPE: Postgres has no cast from uuid to bigint, so the generated
-- `SET DATA TYPE` form is refused outright. Dropping and re-adding NOT NULL without a default makes
-- the outcome depend on the data: it succeeds on an empty table, which is every new environment and
-- every CI run, and it fails on a table that still holds rows — which is correct, because those
-- rows reference user ids that no longer exist anywhere. Recreate the database in that case.
--
-- Dropping the column drops the indexes over it, so they are rebuilt here.
ALTER TABLE "carts" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "user_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_unique" UNIQUE("user_id");--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "user_id" bigint NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_orders_user" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_user_idempotency_key" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "media_assets" DROP COLUMN "uploaded_by";--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "uploaded_by" bigint NOT NULL;
