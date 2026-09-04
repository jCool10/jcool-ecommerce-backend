import type { Product } from '../../domain/entities';
import type { SearchableProduct } from '../../application/ports';

// Sole pricing currency today; a variant priced only in another currency reads as unpriced here, the
// same VND-scoped read the SKU view uses, so search and product detail agree on the price shown.
const DEFAULT_CURRENCY = 'VND';

/**
 * Flatten a Product graph into one denormalized search document. The engine cannot join, so SKU codes
 * and the price range are folded in for matching, filtering and display in a single query. Pure — no
 * SDK, no I/O.
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
