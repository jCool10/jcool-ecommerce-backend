import type { OutboxRecord } from '@shared/messaging/outbox/outbox-writer.port';

// Thin events: the consumer re-reads Postgres, so the payload carries nothing to version.

export const PRODUCT_CHANGED_EVENT = 'catalog.product.changed';
export const CATEGORY_RENAMED_EVENT = 'catalog.category.renamed';

export function toProductChangedRecord(productId: string): OutboxRecord {
  return { aggregateType: 'Product', aggregateId: productId, eventType: PRODUCT_CHANGED_EVENT, payload: {} };
}

export function toCategoryRenamedRecord(categoryId: string): OutboxRecord {
  return { aggregateType: 'Category', aggregateId: categoryId, eventType: CATEGORY_RENAMED_EVENT, payload: {} };
}
