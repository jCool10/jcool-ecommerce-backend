import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

// Same order as ORDER_STATUSES: drizzle-kit then adds a new value BEFORE its neighbour.
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

// No default: the id is minted by the id service, not the database.
const id = () => snowflakeId('id').primaryKey();

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
    userId: snowflakeId('user_id').notNull(),
    status: orderStatus('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    // Snapshot total in smallest units; never a float. bigint (not int4) because the
    // aggregate can exceed int4 even when each line fits (Σ across lines / quantity).
    // `mode: 'number'` — order totals stay well inside JS safe-integer range.
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    // Nothing reads this yet: placement uses a status-based conditional UPDATE. Reserved for
    // version-based aggregate concurrency.
    version: integer('version').notNull().default(0),
    // The client Idempotency-Key that created this order, stamped at checkout as the exit-defense
    // backstop for retry-safety. Scoped per user by the composite unique below, so two users may
    // reuse the same key value without colliding.
    idempotencyKey: text('idempotency_key'),
    // Set when checkout writes RESERVING; null while still a draft.
    placedAt: timestamp('placed_at', { withTimezone: true }),
    // Stamped once, when the order settles (REJECTED included); null while in flight. Idempotency
    // reads `status`, not these — they carry the when/why for reconciliation.
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizeReason: text('finalize_reason'), // e.g. 'user:cancel' | 'saga:expired' | 'saga:try_failed'
    paymentRef: text('payment_ref'), // the payment the saga captured, on a PAID order
    // Saga orders only: placed_at + CHECKOUT_PAYMENT_DEADLINE_SEC. Null on legacy orders.
    paymentDeadlineAt: timestamp('payment_deadline_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_orders_id_routable', t.id),
    routableIdCheck('ck_orders_user_id_routable', t.userId),
    index('idx_orders_user').on(t.userId),
    // Per-user idempotency, matching the store's (scope, key) scope: at most one order per
    // (user, key). NULL keys don't collide (Postgres treats them as distinct), so pre-idempotency
    // orders are unaffected. The final backstop behind the per-key entry gate.
    uniqueIndex('uq_orders_user_idempotency_key').on(t.userId, t.idempotencyKey),
    // No predicate: a partial index naming a value added to the enum in the same migration fails
    // (unsafe use of a new enum value), and the saga's reaper scans RESERVING and PENDING alike.
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
    // Product-variant id (SKU). No FK to catalog — cross-context boundary.
    skuId: snowflakeId('sku_id').notNull(),
    // Name + price SNAPSHOT at creation time (transactional truth, not live).
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
