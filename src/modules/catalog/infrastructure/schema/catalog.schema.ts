import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

// Catalog schema (products/variants/prices/categories). Infrastructure, never
// imported by domain. Money is integer `amount_minor` (smallest unit, no float);
// ids are app-generated cuid2.

export const productStatus = pgEnum('product_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => createId());

// Timezone-aware audit stamps; `updatedAt` bumped app-side on every UPDATE.
const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// Soft-delete marker (null = active). Product uses status='ARCHIVED' instead, so
// it carries no archivedAt.
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const categories = pgTable('categories', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Self-reference for nested categories; no FK yet (YAGNI).
  parentId: text('parent_id'),
  archivedAt: archivedAt(),
  ...stamps,
});

export const products = pgTable(
  'products',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    status: productStatus('status').notNull().default('DRAFT'),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    ...stamps,
  },
  (t) => [index('idx_products_category').on(t.categoryId), index('idx_products_status').on(t.status)],
);

// A ProductVariant IS the sellable SKU; `sku` is globally unique. Inventory will
// reference `variantId`, so this id contract is kept stable on purpose.
export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    archivedAt: archivedAt(),
    ...stamps,
  },
  (t) => [index('idx_variants_product').on(t.productId)],
);

export const prices = pgTable(
  'prices',
  {
    id: id(),
    variantId: text('variant_id')
      .notNull()
      .references(() => productVariants.id),
    currency: text('currency').notNull().default('VND'),
    // Integer smallest-unit amount (e.g. VND đồng). Never float.
    amountMinor: integer('amount_minor').notNull(),
    ...stamps,
  },
  (t) => [uniqueIndex('uq_prices_variant_currency').on(t.variantId, t.currency)],
);
