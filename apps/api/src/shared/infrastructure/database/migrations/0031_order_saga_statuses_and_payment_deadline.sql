ALTER TYPE "public"."order_status" ADD VALUE 'RESERVING' BEFORE 'PENDING';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'CONFIRMING' BEFORE 'PAID';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'REJECTED';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_orders_status_placed_at" ON "orders" USING btree ("status","placed_at");