-- Added nullable, backfilled, then constrained: `ADD COLUMN ... NOT NULL` in one step cannot work
-- on a table with rows. The whole file runs in one transaction, so the guard below aborts every
-- statement here rather than leaving the column half-applied.
ALTER TABLE "orders" ADD COLUMN "buyer_email" text;--> statement-breakpoint
UPDATE "orders" o SET "buyer_email" = u."email" FROM "users" u WHERE u."id" = o."user_id";--> statement-breakpoint
-- `orders.user_id` has no foreign key, so an order whose user was deleted survives the backfill with
-- a NULL. Failing here names the count; failing on SET NOT NULL would only say "column contains
-- null values".
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "buyer_email" IS NULL) THEN
    RAISE EXCEPTION 'buyer_email backfill incomplete: % rows have no matching user',
      (SELECT count(*) FROM "orders" WHERE "buyer_email" IS NULL);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "buyer_email" SET NOT NULL;
