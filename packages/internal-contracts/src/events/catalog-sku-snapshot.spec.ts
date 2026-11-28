import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  MAX_CATALOG_SNAPSHOT_PRICE_MINOR,
  MAX_CATALOG_SNAPSHOT_VERSION,
  catalogSkuSnapshotDefect,
  catalogSkuSnapshotPayload,
  isCatalogSkuSnapshotPayload,
} from './catalog-sku-snapshot';

const SKU = { skuId: '6797560428102657', unitPriceMinor: 249_000, currency: 'VND', isActive: true };

const PAYLOAD = {
  productId: '6797560428102656',
  version: 3,
  productName: 'Linen shirt',
  skus: [SKU, { skuId: '6797560428102658', unitPriceMinor: null, currency: 'VND', isActive: false }],
};

describe('catalog.product.sku-snapshot payload', () => {
  it('is named apart from the thin catalog.product.changed', () => {
    expect(CATALOG_SKU_SNAPSHOT_EVENT).toBe('catalog.product.sku-snapshot');
  });

  it('pins both ceilings to the int4 columns they are read from', () => {
    expect(MAX_CATALOG_SNAPSHOT_VERSION).toBe(2_147_483_647);
    expect(MAX_CATALOG_SNAPSHOT_PRICE_MINOR).toBe(2_147_483_647);
  });

  it.each([
    ['a priced and an unpriced SKU', PAYLOAD],
    ['a product without SKUs', { ...PAYLOAD, skus: [] }],
    ['version 0', { ...PAYLOAD, version: 0 }],
    ['the version ceiling', { ...PAYLOAD, version: 2_147_483_647 }],
    ['the price ceiling', { ...PAYLOAD, skus: [{ ...SKU, unitPriceMinor: 2_147_483_647 }] }],
    ['a price of 1', { ...PAYLOAD, skus: [{ ...SKU, unitPriceMinor: 1 }] }],
    ['fields it does not know', { ...PAYLOAD, extra: true, skus: [{ ...SKU, extra: true }] }],
  ])('accepts %s', (_case, payload) => {
    expect(catalogSkuSnapshotDefect(payload)).toBeUndefined();
    expect(isCatalogSkuSnapshotPayload(payload)).toBe(true);
  });

  it.each([
    ['a negative version', { version: -1 }, 'version'],
    ['a fractional version', { version: 1.5 }, 'version'],
    ['a version past the ceiling', { version: 2_147_483_648 }, 'version'],
    ['a string version', { version: '3' }, 'version'],
    ['an empty productId', { productId: '' }, 'productId'],
    ['a numeric productId', { productId: 6797560428102656 }, 'productId'],
    ['an empty productName', { productName: '' }, 'productName'],
    [
      'a productName holding a NUL byte, which Postgres text refuses',
      { productName: 'Linen\u0000shirt' },
      'productName',
    ],
    ['skus that are not a list', { skus: {} }, 'skus'],
  ])('refuses %s, naming the field', (_case, override, field) => {
    const payload = { ...PAYLOAD, ...override };

    expect(isCatalogSkuSnapshotPayload(payload)).toBe(false);
    expect(catalogSkuSnapshotDefect(payload)).toMatch(new RegExp(`^${field} `));
  });

  it.each(['productId', 'version', 'productName', 'skus'])('refuses a payload without %s', (field) => {
    const { [field as keyof typeof PAYLOAD]: _dropped, ...rest } = PAYLOAD;

    expect(catalogSkuSnapshotDefect(rest)).toMatch(new RegExp(`^${field} `));
  });

  it.each([
    ['a lower-case currency', { currency: 'vnd' }, 'currency'],
    ['another currency', { currency: 'USD' }, 'currency'],
    ['a lower-case foreign currency', { currency: 'usd' }, 'currency'],
    ['a zero price', { unitPriceMinor: 0 }, 'unitPriceMinor'],
    ['a negative price', { unitPriceMinor: -1 }, 'unitPriceMinor'],
    ['a fractional price', { unitPriceMinor: 1.5 }, 'unitPriceMinor'],
    ['a price past the ceiling', { unitPriceMinor: 2_147_483_648 }, 'unitPriceMinor'],
    ['a string price', { unitPriceMinor: '249000' }, 'unitPriceMinor'],
    ['a missing price', { unitPriceMinor: undefined }, 'unitPriceMinor'],
    ['a non-boolean isActive', { isActive: 'true' }, 'isActive'],
    ['an empty skuId', { skuId: '' }, 'skuId'],
  ])('refuses a SKU with %s, naming its index and field', (_case, override, field) => {
    const payload = { ...PAYLOAD, skus: [SKU, { ...SKU, skuId: '6797560428102659', ...override }] };

    expect(isCatalogSkuSnapshotPayload(payload)).toBe(false);
    expect(catalogSkuSnapshotDefect(payload)).toMatch(new RegExp(`^skus\\[1\\]\\.${field} `));
  });

  // One upsert statement cannot touch the same row twice; Postgres would fail it on every retry.
  it('refuses a SKU listed twice', () => {
    expect(catalogSkuSnapshotDefect({ ...PAYLOAD, skus: [SKU, SKU] })).toMatch(/^skus\[1\]\.skuId repeats/);
  });

  it.each([null, undefined, [], 'catalog.product.sku-snapshot', 42])('refuses %j as a payload', (payload) => {
    expect(isCatalogSkuSnapshotPayload(payload)).toBe(false);
  });

  // A forged name is not echoed into the logs that print the defect.
  it('never quotes a value in the defect', () => {
    const defect = catalogSkuSnapshotDefect({ ...PAYLOAD, skus: [{ ...SKU, currency: 'SECRET' }] });

    expect(defect).not.toContain('SECRET');
  });

  it('builds a payload the guard accepts, dropping fields the contract does not carry', () => {
    const built = catalogSkuSnapshotPayload({
      ...PAYLOAD,
      skus: PAYLOAD.skus.map((sku) => ({ ...sku, sku: 'LS-01' })),
    });

    expect(built).toEqual(PAYLOAD);
    expect(isCatalogSkuSnapshotPayload(built)).toBe(true);
  });

  it('refuses to build a payload the guard would refuse', () => {
    expect(() => catalogSkuSnapshotPayload({ ...PAYLOAD, skus: [{ ...SKU, unitPriceMinor: 0 }] })).toThrow(
      /skus\[0\]\.unitPriceMinor/,
    );
  });
});
