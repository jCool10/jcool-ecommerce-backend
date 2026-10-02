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

const black = { variantId: 'v1', variantSku: 'WH-BLK', variantName: 'Black' };

describe('assembleProducts', () => {
  it('collapses flattened join rows, deduping variants and prices', () => {
    const rows: ProductFlatRow[] = [
      row({ ...black, priceId: 'pr1', priceCurrency: 'VND', priceAmountMinor: 2_490_000 }),
      row({ ...black, priceId: 'pr2', priceCurrency: 'USD', priceAmountMinor: 99 }),
      // The same price again, as a second join fan-out would repeat it.
      row({ ...black, priceId: 'pr1', priceCurrency: 'VND', priceAmountMinor: 2_490_000 }),
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
    expect(products[0].category).toEqual({ slug: 'electronics', name: 'Electronics' });
    expect(
      products[0].variants.map((variant) => ({
        sku: variant.sku,
        prices: variant.prices.map((price) => `${price.amountMinor} ${price.currency}`),
      })),
    ).toEqual([
      { sku: 'WH-BLK', prices: ['2490000 VND', '99 USD'] },
      { sku: 'WH-WHT', prices: ['2490000 VND'] },
    ]);
  });

  it('preserves first-seen product order', () => {
    const rows: ProductFlatRow[] = [
      row({ productId: 'b', productSlug: 'b' }),
      row({ productId: 'a', productSlug: 'a' }),
      row({ productId: 'b', productSlug: 'b' }),
    ];

    expect(assembleProducts(rows).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('reads the null columns of an unmatched left join as empty variants and prices', () => {
    const products = assembleProducts([
      row({ productId: 'no-variants' }),
      row({ productId: 'unpriced', productSlug: 'unpriced', ...black }),
    ]);

    expect(products.map((product) => product.variants)).toEqual([
      [],
      [{ id: 'v1', sku: 'WH-BLK', name: 'Black', prices: [] }],
    ]);
  });
});
