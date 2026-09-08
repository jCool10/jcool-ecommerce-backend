import { Money } from '@shared/kernel';
import { Product, type ProductVariant } from '../domain/entities';
import { toSearchableProduct } from './catalog-search.mapper';

function variant(sku: string, ...prices: Money[]): ProductVariant {
  return { id: `v-${sku}`, sku, name: sku, prices };
}

function product(variants: ProductVariant[], createdAt = new Date('2026-01-02T03:04:05.000Z')): Product {
  return new Product(
    'p1',
    'Wireless Headphones',
    'wireless-headphones',
    'Over-ear',
    'ACTIVE',
    { slug: 'electronics', name: 'Electronics' },
    variants,
    createdAt,
  );
}

describe('toSearchableProduct', () => {
  it('collects every SKU and takes the cheapest VND price as the range floor', () => {
    const doc = toSearchableProduct(
      product([variant('WH-BLK', Money.of(2_490_000, 'VND')), variant('WH-WHT', Money.of(1_990_000, 'VND'))]),
    );

    expect(doc.skus).toEqual(['WH-BLK', 'WH-WHT']);
    expect(doc.minPriceMinor).toBe(1_990_000);
    expect(doc.currency).toBe('VND');
  });

  it('reads as unpriced when no variant has a price', () => {
    const doc = toSearchableProduct(product([variant('WH-BLK')]));

    expect(doc.minPriceMinor).toBeNull();
    expect(doc.currency).toBeNull();
  });

  // The amount and the currency label are rendered together, so mixing them would advertise a USD
  // price as VND.
  it('ignores a non-VND price when picking the floor', () => {
    const doc = toSearchableProduct(
      product([variant('WH-BLK', Money.of(1_990_000, 'VND')), variant('WH-USD', Money.of(1299, 'USD'))]),
    );

    expect(doc.minPriceMinor).toBe(1_990_000);
    expect(doc.currency).toBe('VND');
  });

  it('reads as unpriced when every price is in another currency', () => {
    const doc = toSearchableProduct(product([variant('WH-USD', Money.of(1299, 'USD'))]));

    expect(doc.minPriceMinor).toBeNull();
    expect(doc.currency).toBeNull();
  });

  it('encodes createdAt as epoch millis for numeric recency sort', () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const doc = toSearchableProduct(product([variant('WH-BLK')], createdAt));

    expect(doc.createdAtEpoch).toBe(createdAt.getTime());
  });

  it('carries a null description through without throwing', () => {
    const base = product([variant('WH-BLK')]);
    const noDescription = new Product(
      base.id,
      base.name,
      base.slug,
      null,
      base.status,
      base.category,
      base.variants,
      base.createdAt,
    );

    expect(toSearchableProduct(noDescription).description).toBeNull();
  });
});
