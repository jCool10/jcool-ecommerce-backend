import { Money } from '@jcool/kernel';
import { Product, type ProductVariant } from '../domain/entities';
import { toSearchableProduct } from './catalog-search.mapper';

function variant(sku: string, ...prices: Money[]): ProductVariant {
  return { id: `v-${sku}`, sku, name: sku, prices };
}

function product(variants: ProductVariant[]): Product {
  return new Product(
    'p1',
    'Wireless Headphones',
    'wireless-headphones',
    'Over-ear',
    'ACTIVE',
    { slug: 'electronics', name: 'Electronics' },
    variants,
    new Date('2026-01-02T03:04:05.000Z'),
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

  // The amount and the currency label render together, so mixing them would advertise a USD price
  // as VND.
  it('ignores a non-VND price when picking the floor', () => {
    const doc = toSearchableProduct(
      product([variant('WH-BLK', Money.of(1_990_000, 'VND')), variant('WH-USD', Money.of(1299, 'USD'))]),
    );

    expect(doc.minPriceMinor).toBe(1_990_000);
    expect(doc.currency).toBe('VND');
  });

  it('reads as unpriced when no variant has a VND price', () => {
    const unpriced = [product([variant('WH-BLK')]), product([variant('WH-USD', Money.of(1299, 'USD'))])];

    expect(
      unpriced.map(toSearchableProduct).map(({ minPriceMinor, currency }) => ({ minPriceMinor, currency })),
    ).toEqual([
      { minPriceMinor: null, currency: null },
      { minPriceMinor: null, currency: null },
    ]);
  });
});
