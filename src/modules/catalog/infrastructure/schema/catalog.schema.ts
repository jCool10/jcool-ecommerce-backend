import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Infrastructure only — the domain layer must never import this module.

export const productStatus = pgEnum('product_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

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

// Soft-delete marker (null = active). Products use status='ARCHIVED' instead, hence no column there.
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const categories = pgTable('categories', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Self-reference for nested categories; deliberately no FK yet.
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

// A ProductVariant IS the sellable SKU. Other contexts reference `variantId`, so this id contract
// is kept stable on purpose.
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

// `assetId` deliberately carries NO foreign key to Media's table: cross-context references are
// enforced at the app layer. Catalog stores the id and never a URL — Media resolves one after the
// cache is read, so an expiring URL can never be cached.
export const productImages = pgTable(
  'product_images',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    assetId: uuid('asset_id').notNull(),
    position: integer('position').notNull().default(0),
    alt: text('alt'),
    ...stamps,
  },
  (t) => [
    index('idx_product_images_product_position').on(t.productId, t.position),
    // One asset appears at most once on a product: a second row would attach an already-ATTACHED
    // asset, which the state machine refuses anyway — this makes the database say so too.
    uniqueIndex('uq_product_images_product_asset').on(t.productId, t.assetId),
  ],
);

export const prices = pgTable(
  'prices',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    currency: text('currency').notNull().default('VND'),
    amountMinor: integer('amount_minor').notNull(),
    ...stamps,
  },
  (t) => [uniqueIndex('uq_prices_variant_currency').on(t.variantId, t.currency)],
);
