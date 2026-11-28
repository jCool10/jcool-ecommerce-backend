import { describe, expect, it } from 'vitest';
import { isCatalogSkuSnapshotPayload } from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { toCategoryRenamedRecord, toProductChangedRecord, toSkuSnapshotRecord } from './catalog-outbox.mapper';

const PRODUCT_ID = '01a03000-0000-7000-8000-000000000011';
const CATEGORY_ID = '01a03000-0000-7000-8000-000000000012';

const sku = (skuId: string, unitPriceMinor: number | null) => ({
  skuId,
  unitPriceMinor,
  currency: 'VND',
  isActive: true,
});

describe('catalog outbox mapper', () => {
  it('maps a product change to catalog.product.changed on the product, with an empty payload', () => {
    expect(toProductChangedRecord(PRODUCT_ID)).toEqual({
      aggregateType: 'Product',
      aggregateId: PRODUCT_ID,
      eventType: 'catalog.product.changed',
      payload: {},
    });
  });

  it('maps a product state to catalog.product.sku-snapshot on the product, carrying the state', () => {
    const state = { productId: PRODUCT_ID, version: 4, productName: 'Linen shirt', skus: [sku('21', 249_000)] };

    const record = toSkuSnapshotRecord(state);

    expect(record).toEqual({
      aggregateType: 'Product',
      aggregateId: PRODUCT_ID,
      eventType: 'catalog.product.sku-snapshot',
      payload: state,
    });
    expect(isCatalogSkuSnapshotPayload(record.payload)).toBe(true);
  });

  // A stored price below 1 predates the floor or was written by hand; it reads as unpriced rather
  // than dead-lettering every snapshot of its product.
  it('publishes a stored price below 1 as unpriced', () => {
    const state = {
      productId: PRODUCT_ID,
      version: 4,
      productName: 'Linen shirt',
      skus: [sku('21', 0), sku('22', -5), sku('23', 1), sku('24', null)],
    };

    expect(toSkuSnapshotRecord(state).payload).toEqual({
      ...state,
      skus: [sku('21', null), sku('22', null), sku('23', 1), sku('24', null)],
    });
  });

  it('refuses to map a state no consumer would accept', () => {
    const state = { productId: PRODUCT_ID, version: 4, productName: 'Linen shirt', skus: [] };

    expect(() => toSkuSnapshotRecord({ ...state, skus: [{ ...sku('21', 1), currency: 'USD' }] })).toThrow(/currency/);
    expect(() => toSkuSnapshotRecord({ ...state, version: 2_147_483_648 })).toThrow(/version/);
  });

  it('maps a category rename to catalog.category.renamed on the category, with an empty payload', () => {
    expect(toCategoryRenamedRecord(CATEGORY_ID)).toEqual({
      aggregateType: 'Category',
      aggregateId: CATEGORY_ID,
      eventType: 'catalog.category.renamed',
      payload: {},
    });
  });
});
