import { Money } from '../../../shared/kernel';
import { Product, type ProductStatus, type ProductVariant } from '../domain/entities/product.entity';

/**
 * One flattened product×variant×price row (product/category inner-joined so
 * always present; variant/price left-joined so nullable). A plain shape so
 * `assembleProducts` stays pure and Drizzle-independent.
 */
export interface ProductFlatRow {
  productId: string;
  productName: string;
  productSlug: string;
  productDescription: string | null;
  productStatus: ProductStatus;
  productCreatedAt: Date;
  categorySlug: string;
  categoryName: string;
  variantId: string | null;
  variantSku: string | null;
  variantName: string | null;
  priceId: string | null;
  priceCurrency: string | null;
  priceAmountMinor: number | null;
}

interface VariantAcc {
  id: string;
  sku: string;
  name: string;
  prices: Map<string, Money>;
}

interface ProductAcc {
  row: ProductFlatRow;
  variants: Map<string, VariantAcc>;
}

/**
 * Collapse flattened join rows into Product entities, deduping variants (by id)
 * and prices (by id). Product order = first-seen, so the query's ORDER BY controls it.
 */
export function assembleProducts(rows: ProductFlatRow[]): Product[] {
  const acc = new Map<string, ProductAcc>();

  for (const row of rows) {
    let product = acc.get(row.productId);
    if (!product) {
      product = { row, variants: new Map() };
      acc.set(row.productId, product);
    }

    if (row.variantId === null) {
      continue;
    }

    let variant = product.variants.get(row.variantId);
    if (!variant) {
      variant = {
        id: row.variantId,
        sku: row.variantSku ?? '',
        name: row.variantName ?? '',
        prices: new Map(),
      };
      product.variants.set(row.variantId, variant);
    }

    if (
      row.priceId !== null &&
      row.priceCurrency !== null &&
      row.priceAmountMinor !== null &&
      !variant.prices.has(row.priceId)
    ) {
      // Money.of enforces the integer + 3-letter-currency invariant at the
      // persistence boundary; every persisted price already satisfies it (write
      // DTO gates currency `^[A-Z]{3}$`, amount `@IsInt`).
      variant.prices.set(row.priceId, Money.of(row.priceAmountMinor, row.priceCurrency));
    }
  }

  return [...acc.values()].map((product) => {
    const variants: ProductVariant[] = [...product.variants.values()].map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      prices: [...variant.prices.values()],
    }));
    return new Product(
      product.row.productId,
      product.row.productName,
      product.row.productSlug,
      product.row.productDescription,
      product.row.productStatus,
      { slug: product.row.categorySlug, name: product.row.categoryName },
      variants,
      product.row.productCreatedAt,
    );
  });
}
