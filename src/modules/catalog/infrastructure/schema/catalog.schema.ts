import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Catalog schema (products/variants/prices/categories) — infrastructure, never imported by
// domain. Money is integer `amount_minor` (no float); ids are app-generated UUID v7 (native `uuid`).

export const productStatus = pgEnum('product_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

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

// Soft-delete marker (null = active). Product uses status='ARCHIVED' instead, so
// it carries no archivedAt.
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const categories = pgTable('categories', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Self-reference for nested categories; no FK yet (YAGNI).
  parentId: uuid('parent_id'),
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
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    ...stamps,
  },
  (t) => [
    index('idx_products_category').on(t.categoryId),
    index('idx_products_status').on(t.status),
    // Supplies the list page's `ORDER BY created_at DESC, id DESC` so its top-N sort disappears.
    // `nullsFirst` is load-bearing: a query's `desc()` means DESC NULLS FIRST, which a NULLS LAST
    // index cannot supply, so drizzle-kit's default would build an index the planner never uses.
    index('idx_products_active_created')
      .on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.status} = 'ACTIVE'`),
    // Only reachable when the query binds `category_id` itself, not when it filters the category
    // across the join. The trailing `id` covers the id-page projection.
    index('idx_products_category_active_created')
      .on(t.categoryId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.status} = 'ACTIVE'`),
    // `ILIKE '%q%'` leads with a wildcard, so btree cannot seek and only trigrams can index it.
    index('idx_products_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

// A ProductVariant IS the sellable SKU; `sku` is globally unique. Inventory will
// reference `variantId`, so this id contract is kept stable on purpose.
export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    productId: uuid('product_id')
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
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    currency: text('currency').notNull().default('VND'),
    // Integer smallest-unit amount (e.g. VND đồng). Never float.
    amountMinor: integer('amount_minor').notNull(),
    ...stamps,
  },
  (t) => [uniqueIndex('uq_prices_variant_currency').on(t.variantId, t.currency)],
);
