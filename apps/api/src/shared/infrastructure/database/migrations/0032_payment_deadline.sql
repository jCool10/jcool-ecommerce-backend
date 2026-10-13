DROP INDEX "idx_orders_pending_placed_at";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_orders_status_placed_at" ON "orders" USING btree ("status","placed_at");