import { Money } from '@shared/kernel';
import { Product, PRODUCT_STATUSES, type ProductStatus, type ProductVariant } from '../domain/entities';

/**
 * JSON-safe mirror of the `Product` read aggregate. The entity holds `Money` value objects and a
 * `Date`, neither of which survives a JSON round-trip, so the cache stores this shape and
 * rehydrates through `Money.of`.
 *
 * A cached entry is data written by some earlier deploy, not a value the compiler ever checked —
 * `JSON.parse` returns whatever is in Redis under this type. So `fromProductSnapshot` validates
 * every field it reads: shape drift then surfaces as a throw the caching decorator catches and
 * refills, instead of a `Product` carrying `undefined` that blows up further downstream (the
 * response mapper dereferences `category.slug`, which would be a 500 on a read path).
 */
export interface ProductSnapshot {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProductStatus;
  category: { slug: string; name: string };
  variants: { id: string; sku: string; name: string; prices: { amountMinor: number; currency: string }[] }[];
  createdAt: string;
  imageAssetIds: string[];
}

export interface ProductListSnapshot {
  items: ProductSnapshot[];
  total: number;
}

export function toProductSnapshot(product: Product): ProductSnapshot {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    status: product.status,
    category: { slug: product.category.slug, name: product.category.name },
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      prices: variant.prices.map((price) => ({ amountMinor: price.amountMinor, currency: price.currency })),
    })),
    createdAt: product.createdAt.toISOString(),
    // Ids, not URLs: a presigned URL outlives this snapshot by minutes, the entry by hours.
    imageAssetIds: [...product.imageAssetIds],
  };
}

export function toProductListSnapshot(result: { items: Product[]; total: number }): ProductListSnapshot {
  return { items: result.items.map(toProductSnapshot), total: result.total };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Cached product snapshot: ${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Cached product snapshot: ${field} is not an array`);
  }
  return value as unknown[];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Cached product snapshot: ${field} is not a string`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`Cached product snapshot: ${field} is not a number`);
  }
  return value;
}

function asStatus(value: unknown): ProductStatus {
  const status = asString(value, 'status');
  if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) {
    throw new TypeError(`Cached product snapshot: unknown status ${status}`);
  }
  return status as ProductStatus;
}

export function fromProductSnapshot(snapshot: unknown): Product {
  const raw = asRecord(snapshot, 'snapshot');
  const category = asRecord(raw.category, 'category');

  const variants: ProductVariant[] = asArray(raw.variants, 'variants').map((entry) => {
    const variant = asRecord(entry, 'variant');
    return {
      id: asString(variant.id, 'variant.id'),
      sku: asString(variant.sku, 'variant.sku'),
      name: asString(variant.name, 'variant.name'),
      // `Money.of` re-checks the integer/currency invariant on top of the type check here.
      prices: asArray(variant.prices, 'variant.prices').map((priceEntry) => {
        const price = asRecord(priceEntry, 'variant.price');
        return Money.of(
          asNumber(price.amountMinor, 'variant.price.amountMinor'),
          asString(price.currency, 'variant.price.currency'),
        );
      }),
    };
  });

  const createdAt = new Date(asString(raw.createdAt, 'createdAt'));
  if (Number.isNaN(createdAt.getTime())) {
    throw new TypeError(`Unparseable createdAt in cached product snapshot: ${String(raw.createdAt)}`);
  }

  return new Product(
    asString(raw.id, 'id'),
    asString(raw.name, 'name'),
    asString(raw.slug, 'slug'),
    raw.description === null ? null : asString(raw.description, 'description'),
    asStatus(raw.status),
    { slug: asString(category.slug, 'category.slug'), name: asString(category.name, 'category.name') },
    variants,
    createdAt,
    asArray(raw.imageAssetIds, 'imageAssetIds').map((entry) => asString(entry, 'imageAssetIds[]')),
  );
}

export function fromProductListSnapshot(snapshot: unknown): { items: Product[]; total: number } {
  const raw = asRecord(snapshot, 'list snapshot');
  return {
    // `total` drives the pagination the client sees, so it is checked as strictly as the items are.
    items: asArray(raw.items, 'items').map(fromProductSnapshot),
    total: asNumber(raw.total, 'total'),
  };
}
