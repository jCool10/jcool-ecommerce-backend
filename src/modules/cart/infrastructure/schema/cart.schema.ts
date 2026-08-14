import { integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Cart schema (one active cart per user + its items) — infrastructure, never
// imported by domain. Same conventions as the other contexts (UUID v7 ids, tz
// stamps). Cart is scratch space: it stores only { skuId, quantity } — no price
// snapshot (that is Order's job). By design there is NO cross-context FK
// (userId → users, skuId → product_variants): the boundary is kept at the
// application layer (reads go through Catalog's published port), so the DB does
// not couple Cart to another context's tables.

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

// Timezone-aware audit stamps; `updatedAt` bumped app-side on every UPDATE.
const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const carts = pgTable('carts', {
  id: id(),
  // One active cart per user (enforced unique); no FK — cross-context boundary.
  userId: uuid('user_id').notNull().unique(),
  ...stamps,
});

export const cartItems = pgTable(
  'cart_items',
  {
    id: id(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    // Product-variant id (SKU). No FK to catalog — cross-context boundary.
    skuId: uuid('sku_id').notNull(),
    // Always >= 1 (validated at the DTO edge); one row per SKU → add accumulates.
    quantity: integer('quantity').notNull(),
    ...stamps,
  },
  (t) => [uniqueIndex('uq_cart_items_cart_sku').on(t.cartId, t.skuId)],
);
