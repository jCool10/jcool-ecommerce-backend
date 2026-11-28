import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  type CatalogSkuSnapshotPayload,
  catalogSkuSnapshotPayload,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import type { OutboxRecord } from '@jcool/messaging/outbox-port';

// Thin events: the consumer re-reads Postgres, so the payload carries nothing to version.

export const PRODUCT_CHANGED_EVENT = 'catalog.product.changed';
export const CATEGORY_RENAMED_EVENT = 'catalog.category.renamed';

export function toProductChangedRecord(productId: string): OutboxRecord {
  return { aggregateType: 'Product', aggregateId: productId, eventType: PRODUCT_CHANGED_EVENT, payload: {} };
}

export function toCategoryRenamedRecord(categoryId: string): OutboxRecord {
  return { aggregateType: 'Category', aggregateId: categoryId, eventType: CATEGORY_RENAMED_EVENT, payload: {} };
}

/**
 * Fat, unlike the two above: the order-service cannot re-read this database. A stored price below 1
 * reads as unpriced, and the contract's builder throws on anything else a consumer would refuse.
 */
export function toSkuSnapshotRecord(state: CatalogSkuSnapshotPayload): OutboxRecord {
  const payload = catalogSkuSnapshotPayload({
    ...state,
    skus: state.skus.map((sku) => ({
      ...sku,
      unitPriceMinor: sku.unitPriceMinor !== null && sku.unitPriceMinor >= 1 ? sku.unitPriceMinor : null,
    })),
  });
  return {
    aggregateType: 'Product',
    aggregateId: state.productId,
    eventType: CATALOG_SKU_SNAPSHOT_EVENT,
    payload: { ...payload },
  };
}
