import { check, index, integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Inventory schema (stock levels + reservations) — infrastructure, never imported
// by domain. UUID v7 ids, tz stamps, integer counts. No cross-context FK
// (variantId → product_variants, orderId → orders): boundary kept at the app layer.
// Stock is held (reserved) at placement, never subtracted from on-hand until commit.

export const reservationStatus = pgEnum('reservation_status', ['HELD', 'RELEASED', 'COMMITTED']);

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

// One row per SKU. `available = quantity_on_hand − quantity_reserved` is derived.
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: id(),
    variantId: uuid('variant_id').notNull().unique(),
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    quantityReserved: integer('quantity_reserved').notNull().default(0),
    // Optimistic-lock counter — CAS target for the version+retry strategy.
    version: integer('version').notNull().default(0),
    ...stamps,
  },
  (t) => [
    check('ck_stock_on_hand_nonneg', sql`${t.quantityOnHand} >= 0`),
    check('ck_stock_reserved_nonneg', sql`${t.quantityReserved} >= 0`),
    // Oversell invariant enforced at the data layer — Postgres refuses to commit
    // reserved > on_hand even if the app-layer lock is wrong.
    check('ck_stock_no_oversell', sql`${t.quantityReserved} <= ${t.quantityOnHand}`),
  ],
);

// One hold of stock for one SKU of one order. HELD at placement; COMMITTED on
// payment or RELEASED on failure/expiry. `expiresAt` marks when a TTL sweep may
// release an unpaid hold (written now, not yet swept).
export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    orderId: uuid('order_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    status: reservationStatus('status').notNull().default('HELD'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    index('idx_reservations_variant_status').on(t.variantId, t.status),
    // One hold per (order, SKU); its left-most prefix also serves WHERE order_id = ?.
    uniqueIndex('uq_reservations_order_variant').on(t.orderId, t.variantId),
  ],
);
