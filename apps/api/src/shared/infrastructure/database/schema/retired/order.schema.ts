import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

// Retired: the order-service owns these tables now and nothing here reads or writes them. The
// definitions stay only so drizzle-kit generates no DROP before the tables are dropped on purpose.

export const orderStatus = pgEnum('order_status', [
  'DRAFT',
  'RESERVING',
  'PENDING',
  'CONFIRMING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
]);
export const idempotencyStatus = pgEnum('idempotency_status', ['IN_PROGRESS', 'COMPLETED']);

const id = () => snowflakeId('id').primaryKey();

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const orders = pgTable(
  'orders',
  {
    id: id(),
    userId: snowflakeId('user_id').notNull(),
    status: orderStatus('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    version: integer('version').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizeReason: text('finalize_reason'),
    paymentRef: text('payment_ref'),
    paymentDeadlineAt: timestamp('payment_deadline_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_orders_id_routable', t.id),
    routableIdCheck('ck_orders_user_id_routable', t.userId),
    index('idx_orders_user').on(t.userId),
    uniqueIndex('uq_orders_user_idempotency_key').on(t.userId, t.idempotencyKey),
    index('idx_orders_status_placed_at').on(t.status, t.placedAt),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: snowflakeId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    skuId: snowflakeId('sku_id').notNull(),
    productName: text('product_name').notNull(),
    unitPrice: integer('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_order_items_id_routable', t.id),
    routableIdCheck('ck_order_items_order_id_routable', t.orderId),
    routableIdCheck('ck_order_items_sku_id_routable', t.skuId),
    index('idx_order_items_order').on(t.orderId),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    orderId: snowflakeId('order_id'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    routableIdCheck('ck_idempotency_keys_id_routable', t.id),
    routableIdCheck('ck_idempotency_keys_order_id_routable', t.orderId),
    uniqueIndex('uq_idempotency_scope_key').on(t.scope, t.key),
    index('idx_idempotency_expires').on(t.expiresAt),
  ],
);
