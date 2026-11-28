import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database';
import { prices, productVariants, products } from './schema/catalog.schema';

// Must match the schema default (prices.currency) and the admin write default: the SKU view reads
// the price in this currency only, so a divergence silently makes every SKU read as unpriced rather
// than erroring. Acceptable while VND is the sole currency.
export const SKU_VIEW_CURRENCY = 'VND';

export interface SkuViewRecord {
  skuId: string;
  productName: string;
  unitPriceMinor: number | null;
  currency: string;
  /** True only when the product is ACTIVE and the variant is not archived. */
  isActive: boolean;
}

/**
 * The one projection of a SKU as the catalog sells it, for every variant matching `where` (a
 * predicate on `product_variants`). No ACTIVE filter: a SKU whose product was archived still
 * resolves, flagged inactive. `uq_prices_variant_currency` keeps the left join from fanning a SKU out
 * into duplicates; the left join itself keeps an unpriced SKU resolvable.
 */
export async function selectSkuViews(db: DrizzleDB | DrizzleTx, where: SQL): Promise<SkuViewRecord[]> {
  const rows = await db
    .select({
      skuId: productVariants.id,
      productName: products.name,
      productStatus: products.status,
      variantArchivedAt: productVariants.archivedAt,
      amountMinor: prices.amountMinor,
      currency: prices.currency,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(prices, and(eq(prices.variantId, productVariants.id), eq(prices.currency, SKU_VIEW_CURRENCY)))
    .where(where)
    .orderBy(asc(productVariants.id));

  return rows.map((row) => ({
    skuId: row.skuId,
    productName: row.productName,
    unitPriceMinor: row.amountMinor ?? null,
    currency: row.currency ?? SKU_VIEW_CURRENCY,
    isActive: row.productStatus === 'ACTIVE' && row.variantArchivedAt === null,
  }));
}
