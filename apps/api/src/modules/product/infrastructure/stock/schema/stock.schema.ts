import { check, index, integer, pgEnum, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

// No cross-context FK (variantId → product_variants, orderId → orders): the boundary is kept at the
// app layer. Stock is held (reserved) at placement, never subtracted from on-hand until commit.

export const reservationStatus = pgEnum('reservation_status', ['HELD', 'RELEASED', 'COMMITTED', 'RESTOCKED']);

export const reservationOrderStatus = pgEnum('reservation_order_status', [
  'HELD',
  'COMMITTED',
  'RELEASED',
  'FENCED',
  'RESTOCKED',
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

// `available = quantity_on_hand − quantity_reserved` is derived, deliberately not a column.
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: id(),
    variantId: snowflakeId('variant_id').notNull().unique(),
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    quantityReserved: integer('quantity_reserved').notNull().default(0),
    // Optimistic-lock counter — CAS target for the version+retry strategy.
    version: integer('version').notNull().default(0),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_stock_levels_id_routable', t.id),
    routableIdCheck('ck_stock_levels_variant_id_routable', t.variantId),
    check('ck_stock_on_hand_nonneg', sql`${t.quantityOnHand} >= 0`),
    check('ck_stock_reserved_nonneg', sql`${t.quantityReserved} >= 0`),
    // Oversell invariant enforced at the data layer — Postgres refuses to commit
    // reserved > on_hand even if the app-layer lock is wrong.
    check('ck_stock_no_oversell', sql`${t.quantityReserved} <= ${t.quantityOnHand}`),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    orderId: snowflakeId('order_id').notNull(),
    variantId: snowflakeId('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    status: reservationStatus('status').notNull().default('HELD'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_reservations_id_routable', t.id),
    routableIdCheck('ck_reservations_order_id_routable', t.orderId),
    routableIdCheck('ck_reservations_variant_id_routable', t.variantId),
    index('idx_reservations_variant_status').on(t.variantId, t.status),
    // One hold per (order, SKU); its left-most prefix also serves WHERE order_id = ?.
    uniqueIndex('uq_reservations_order_variant').on(t.orderId, t.variantId),
    // Partial: the sweep's queue is only ever HELD rows, so the index stays proportional to holds in
    // flight rather than to every reservation ever written — and it supplies the oldest-first sort.
    index('idx_reservations_held_expires_at')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'HELD'`),
  ],
);

// Per-order fence for the participant path: serializes Try against release so a late Try sees it lost.
export const reservationOrders = pgTable(
  'reservation_orders',
  {
    orderId: snowflakeId('order_id').primaryKey(),
    status: reservationOrderStatus('status').notNull(),
    holdUntil: timestamp('hold_until', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_reservation_orders_order_id_routable', t.orderId),
    index('idx_reservation_orders_held_hold_until')
      .on(t.holdUntil)
      .where(sql`${t.status} = 'HELD'`),
  ],
);
