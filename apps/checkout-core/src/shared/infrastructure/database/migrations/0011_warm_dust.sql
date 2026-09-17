ALTER TABLE "orders" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "finalize_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_ref" text;