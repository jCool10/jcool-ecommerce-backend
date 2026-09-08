import type { Product } from '../domain/entities';
import type { SearchableProduct } from './ports';

// Sole pricing currency today; a variant priced only in another currency reads as unpriced here, the
// same VND-scoped read the SKU view uses, so search and product detail agree on the price shown.
const DEFAULT_CURRENCY = 'VND';

/**
 * Pure — no SDK, no I/O — which is why it sits in application: both the reindex command
 * (infrastructure) and the admin write path build their documents through it.
 */
export function toSearchableProduct(product: Product): SearchableProduct {
  const amountsMinor = product.variants
    .flatMap((variant) => variant.prices)
    .filter((price) => price.currency === DEFAULT_CURRENCY)
    .map((price) => price.amountMinor);
  const minPriceMinor = amountsMinor.length > 0 ? Math.min(...amountsMinor) : null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    categorySlug: product.category.slug,
    categoryName: product.category.name,
    status: product.status,
    skus: product.variants.map((variant) => variant.sku),
    minPriceMinor,
    currency: minPriceMinor === null ? null : DEFAULT_CURRENCY,
    createdAtEpoch: product.createdAt.getTime(),
  };
}
