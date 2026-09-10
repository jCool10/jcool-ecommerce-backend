import { integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// By design there is NO cross-context FK (userId → users, skuId → product_variants): the boundary
// is kept at the application layer (reads go through Catalog's published port), so the DB does not
// couple Cart to another context's tables.

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

export const carts = pgTable('carts', {
  id: id(),
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
    skuId: uuid('sku_id').notNull(),
    // Always >= 1, enforced at the DTO edge rather than by a DB CHECK.
    quantity: integer('quantity').notNull(),
    ...stamps,
  },
  (t) => [uniqueIndex('uq_cart_items_cart_sku').on(t.cartId, t.skuId)],
);
