import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

/**
 * The catalog's SKU views as the api last published them, one row per SKU. Every row of a product
 * carries the product's version, and a snapshot overwrites a row only from a higher one.
 */
export const catalogSkuViews = pgTable(
  'catalog_sku_views',
  {
    skuId: snowflakeId('sku_id').primaryKey(),
    productId: snowflakeId('product_id').notNull(),
    productName: text('product_name').notNull(),
    unitPriceMinor: integer('unit_price_minor'),
    currency: text('currency').notNull(),
    isActive: boolean('is_active').notNull(),
    productVersion: bigint('product_version', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    routableIdCheck('ck_catalog_sku_views_sku_id_routable', t.skuId),
    routableIdCheck('ck_catalog_sku_views_product_id_routable', t.productId),
    check('ck_catalog_sku_views_price_positive', sql`${t.unitPriceMinor} > 0`),
    check('ck_catalog_sku_views_currency_vnd', sql`${t.currency} = 'VND'`),
  ],
);
