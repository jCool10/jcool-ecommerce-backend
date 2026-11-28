import { integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

// By design there is NO foreign key from a cart line to the catalog read model: a SKU the read model
// stops holding must leave the line in place, so checkout can name it.

// No default: the id is minted by the id service, not the database.
const id = () => snowflakeId('id').primaryKey();

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const carts = pgTable(
  'carts',
  {
    id: id(),
    userId: snowflakeId('user_id').notNull().unique(),
    ...stamps,
  },
  (t) => [routableIdCheck('ck_carts_id_routable', t.id), routableIdCheck('ck_carts_user_id_routable', t.userId)],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: id(),
    cartId: snowflakeId('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    skuId: snowflakeId('sku_id').notNull(),
    // Always >= 1, enforced at the DTO edge rather than by a DB CHECK.
    quantity: integer('quantity').notNull(),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_cart_items_id_routable', t.id),
    routableIdCheck('ck_cart_items_cart_id_routable', t.cartId),
    routableIdCheck('ck_cart_items_sku_id_routable', t.skuId),
    uniqueIndex('uq_cart_items_cart_sku').on(t.cartId, t.skuId),
  ],
);
