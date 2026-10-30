CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'RESERVING', 'PENDING', 'CONFIRMING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('IN_PROGRESS', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" bigint PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"product_name" text NOT NULL,
	"unit_price" integer NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_order_items_id_routable" CHECK ("order_items"."id" >= 262144),
	CONSTRAINT "ck_order_items_order_id_routable" CHECK ("order_items"."order_id" >= 262144),
	CONSTRAINT "ck_order_items_sku_id_routable" CHECK ("order_items"."sku_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"placed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalize_reason" text,
	"payment_ref" text,
	"payment_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_orders_id_routable" CHECK ("orders"."id" >= 262144),
	CONSTRAINT "ck_orders_user_id_routable" CHECK ("orders"."user_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" bigint PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"order_id" bigint,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_idempotency_keys_id_routable" CHECK ("idempotency_keys"."id" >= 262144),
	CONSTRAINT "ck_idempotency_keys_order_id_routable" CHECK ("idempotency_keys"."order_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"traceparent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "ck_outbox_id_routable" CHECK ("outbox"."id" >= 262144),
	CONSTRAINT "ck_outbox_aggregate_id_routable" CHECK ("outbox"."aggregate_id" >= 262144)
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" bigint PRIMARY KEY NOT NULL,
	"consumer" text NOT NULL,
	"message_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_inbox_id_routable" CHECK ("inbox"."id" >= 262144),
	CONSTRAINT "ck_inbox_message_id_routable" CHECK ("inbox"."message_id" >= 262144)
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_order_items_order" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_orders_user" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_user_idempotency_key" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_orders_status_placed_at" ON "orders" USING btree ("status","placed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_idempotency_scope_key" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idx_idempotency_expires" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "idx_outbox_published" ON "outbox" USING btree ("published_at") WHERE "outbox"."published_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbox_consumer_message" ON "inbox" USING btree ("consumer","message_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_processed" ON "inbox" USING btree ("processed_at");