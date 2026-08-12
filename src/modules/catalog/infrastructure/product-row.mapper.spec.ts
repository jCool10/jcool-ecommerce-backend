import { assembleProducts, type ProductFlatRow } from './product-row.mapper';

function row(overrides: Partial<ProductFlatRow>): ProductFlatRow {
  return {
    productId: 'p1',
    productName: 'Headphones',
    productSlug: 'headphones',
    productDescription: 'Over-ear',
    productStatus: 'ACTIVE',
    productCreatedAt: new Date('2026-01-01T00:00:00Z'),
    categorySlug: 'electronics',
    categoryName: 'Electronics',
    variantId: null,
    variantSku: null,
    variantName: null,
    priceId: null,
    priceCurrency: null,
    priceAmountMinor: null,
    ...overrides,
  };
}

describe('assembleProducts', () => {
  it('collapses flattened join rows, deduping variants and prices', () => {
    const rows: ProductFlatRow[] = [
      row({
        variantId: 'v1',
        variantSku: 'WH-BLK',
        variantName: 'Black',
        priceId: 'pr1',
        priceCurrency: 'VND',
        priceAmountMinor: 2_490_000,
      }),
      // same variant, second price → one variant, two prices
      row({
        variantId: 'v1',
        variantSku: 'WH-BLK',
        variantName: 'Black',
        priceId: 'pr2',
        priceCurrency: 'USD',
        priceAmountMinor: 99,
      }),
      // second variant, one price
      row({
        variantId: 'v2',
        variantSku: 'WH-WHT',
        variantName: 'White',
        priceId: 'pr3',
        priceCurrency: 'VND',
        priceAmountMinor: 2_490_000,
      }),
    ];

    const products = assembleProducts(rows);

    expect(products).toHaveLength(1);
    const product = products[0];
    expect(product.id).toBe('p1');
    expect(product.category).toEqual({
      slug: 'electronics',
      name: 'Electronics',
    });
    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].prices).toHaveLength(2);
    expect(product.variants[0].prices.map((p) => p.currency)).toEqual(['VND', 'USD']);
    expect(product.variants[1].sku).toBe('WH-WHT');
  });

  it('preserves first-seen product order', () => {
    const rows: ProductFlatRow[] = [
      row({ productId: 'b', productSlug: 'b' }),
      row({ productId: 'a', productSlug: 'a' }),
      row({ productId: 'b', productSlug: 'b' }),
    ];

    expect(assembleProducts(rows).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('yields an empty variants array when a product has no variants', () => {
    const products = assembleProducts([row({ variantId: null })]);

    expect(products).toHaveLength(1);
    expect(products[0].variants).toEqual([]);
  });

  it('ignores a variant row whose price columns are all null', () => {
    const products = assembleProducts([row({ variantId: 'v1', variantSku: 'SKU', variantName: 'V1' })]);

    expect(products[0].variants).toHaveLength(1);
    expect(products[0].variants[0].prices).toEqual([]);
  });
});
