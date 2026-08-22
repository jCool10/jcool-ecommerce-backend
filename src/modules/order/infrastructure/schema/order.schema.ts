import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    // Optimistic-lock counter for the order aggregate (guards concurrent transitions
    // on the same order). Placement currently uses a status-based conditional UPDATE;
    // this column is reserved for version-based aggregate concurrency, not yet read.
    version: integer('version').notNull().default(0),
    // The client Idempotency-Key that created this order (nullable). Stamped at checkout as the
    // exit-defense backstop for retry-safety. Scoped per user (see the composite unique below), so
    // two different users may reuse the same key value without colliding — mirrors the idempotency
    // store's per-user (scope, key) model.
    idempotencyKey: text('idempotency_key'),
    // Set when DRAFT → PENDING; null while still a draft.
    placedAt: timestamp('placed_at', { withTimezone: true }),
    // Stamped once, when the order settles; null while DRAFT/PENDING. Idempotency reads `status`,
    // not these — they carry the when/why for reconciliation.
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizeReason: text('finalize_reason'), // e.g. 'webhook:failed' | 'reconcile:paid' | 'expired'
    paymentRef: text('payment_ref'), // gateway transaction id, when a paid outcome carried one
    ...stamps,
  },
  (t) => [
    index('idx_orders_user').on(t.userId),
    // Per-user idempotency, matching the store's (scope, key) scope: at most one order per
    // (user, key). NULL keys don't collide (Postgres treats them as distinct), so pre-idempotency
    // orders are unaffected. The final backstop behind the per-key entry gate.
    uniqueIndex('uq_orders_user_idempotency_key').on(t.userId, t.idempotencyKey),
    // Partial: the sweep's queue is only ever PENDING rows, so the index stays proportional to
    // orders in flight rather than to every order ever placed.
    index('idx_orders_pending_placed_at')
      .on(t.placedAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
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
