import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Order schema — the transactional source of truth. Infrastructure only, never
// imported by domain. Same conventions as the other contexts (UUID v7 ids, tz
// stamps, integer minor-unit money, NO cross-context FK: userId → users and
// skuId → product_variants stay app-layer boundaries). Order lines COPY name +
// unit price at creation (snapshot), unlike cart lines which read price live.

export const orderStatus = pgEnum('order_status', ['DRAFT', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED']);

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const orders = pgTable(
  'orders',
  {
    id: id(),
    // No FK — cross-context boundary kept at the application layer.
    userId: uuid('user_id').notNull(),
    status: orderStatus('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    // Snapshot total in smallest units; never a float. bigint (not int4) because the
    // aggregate can exceed int4 even when each line fits (Σ across lines / quantity).
    // `mode: 'number'` — order totals stay well inside JS safe-integer range.
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    // EXTENSION BF#1 (T4): optimistic-lock counter for inventory reservation. Reserved — unused in Week 3.
    version: integer('version').notNull().default(0),
    // EXTENSION BF#2 (T5): idempotency key (nullable + unique). Reserved — unused in Week 3.
    idempotencyKey: text('idempotency_key').unique(),
    // Set when DRAFT → PENDING; null while still a draft.
    placedAt: timestamp('placed_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [index('idx_orders_user').on(t.userId)],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Product-variant id (SKU). No FK to catalog — cross-context boundary.
    skuId: uuid('sku_id').notNull(),
    // Name + price SNAPSHOT at creation time (transactional truth, not live).
    productName: text('product_name').notNull(),
    unitPrice: integer('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    ...stamps,
  },
  (t) => [index('idx_order_items_order').on(t.orderId)],
);
