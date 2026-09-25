import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { CatalogSearchPort, ProductSearchStatePort } from '../../application/ports';
import { ProductSearchSyncService } from '../../application/services/product-search-sync.service';
import { fakeCatalogSearch, fakeProductSearchState } from '../../testing/catalog-port.doubles';
import { ProductChangedHandler } from './product-changed.handler';

const PRODUCT_ID = '0198f0d8-4444-7000-8000-000000000001';

function job(aggregateId: string): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000002',
    aggregateType: 'Product',
    aggregateId,
    eventType: 'catalog.product.changed',
    payload: {},
    occurredAt: '2026-09-25T00:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const findByIds = vi
    .fn<ProductSearchStatePort['findByIds']>()
    .mockResolvedValue([{ id: PRODUCT_ID, version: 3, product: null }]);
  const write = vi.fn<CatalogSearchPort['write']>().mockResolvedValue();
  const sync = new ProductSearchSyncService(
    fakeProductSearchState({ findByIds }),
    fakeCatalogSearch({ write }),
    fakePinoLogger(),
  );
  return { handler: new ProductChangedHandler(sync), findByIds, write };
}

describe('ProductChangedHandler', () => {
  it('syncs the product the event names', async () => {
    const { handler, findByIds, write } = build();

    await handler.apply(job(PRODUCT_ID));

    expect(findByIds).toHaveBeenCalledWith([PRODUCT_ID]);
    expect(write).toHaveBeenCalledWith([{ id: PRODUCT_ID, version: 3, doc: null }]);
  });

  // The id comes off Redis; retrying a malformed one only burns the ladder before the DLQ.
  it('refuses a malformed product id as permanent before reading anything', async () => {
    const { handler, findByIds } = build();

    for (const aggregateId of ['', 'not-a-uuid', `${PRODUCT_ID}' OR '1'='1`]) {
      await expect(handler.apply(job(aggregateId))).rejects.toBeInstanceOf(PermanentError);
    }
    expect(findByIds).not.toHaveBeenCalled();
  });
});
