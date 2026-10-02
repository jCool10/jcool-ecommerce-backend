import { describe, expect, it } from 'vitest';
import { toCategoryRenamedRecord, toProductChangedRecord } from './catalog-outbox.mapper';

const PRODUCT_ID = '01a03000-0000-7000-8000-000000000011';
const CATEGORY_ID = '01a03000-0000-7000-8000-000000000012';

describe('catalog outbox mapper', () => {
  it('maps a product change to catalog.product.changed on the product, with an empty payload', () => {
    expect(toProductChangedRecord(PRODUCT_ID)).toEqual({
      aggregateType: 'Product',
      aggregateId: PRODUCT_ID,
      eventType: 'catalog.product.changed',
      payload: {},
    });
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
