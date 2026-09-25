import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { CatalogSearchPort, ProductSearchStatePort } from '../../application/ports';
import { ProductSearchSyncService } from '../../application/services/product-search-sync.service';
import { fakeCatalogSearch, fakeProductSearchState } from '../../testing/catalog-port.doubles';
import { CategoryRenamedHandler } from './category-renamed.handler';

const CATEGORY_ID = '0198f0d8-5555-7000-8000-000000000001';
const PRODUCT_ID = '0198f0d8-5555-7000-8000-000000000002';

function job(aggregateId: string): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000003',
    aggregateType: 'Category',
    aggregateId,
    eventType: 'catalog.category.renamed',
    payload: {},
    occurredAt: '2026-09-25T00:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const bumpCategoryProducts = vi
    .fn<ProductSearchStatePort['bumpCategoryProducts']>()
    .mockResolvedValueOnce([PRODUCT_ID])
    .mockResolvedValue([]);
  const findByIds = vi
    .fn<ProductSearchStatePort['findByIds']>()
    .mockResolvedValue([{ id: PRODUCT_ID, version: 2, product: null }]);
  const write = vi.fn<CatalogSearchPort['write']>().mockResolvedValue();
  const info = vi.fn();
  const sync = new ProductSearchSyncService(
    fakeProductSearchState({ bumpCategoryProducts, findByIds }),
    fakeCatalogSearch({ write }),
    fakePinoLogger(),
  );
  return { handler: new CategoryRenamedHandler(sync, fakePinoLogger({ info })), bumpCategoryProducts, write, info };
}

describe('CategoryRenamedHandler', () => {
  it('rewrites every product of the renamed category and logs how many', async () => {
    const { handler, bumpCategoryProducts, write, info } = build();

    await handler.apply(job(CATEGORY_ID));

    expect(bumpCategoryProducts).toHaveBeenCalledWith(CATEGORY_ID, null, expect.any(Number));
    expect(write).toHaveBeenCalledWith([{ id: PRODUCT_ID, version: 2, doc: null }]);
    expect(info).toHaveBeenCalledWith({ categoryId: CATEGORY_ID, products: 1 }, expect.any(String));
  });

  it('refuses a malformed category id as permanent before touching any product', async () => {
    const { handler, bumpCategoryProducts } = build();

    for (const aggregateId of ['', 'not-a-uuid', `${CATEGORY_ID}' OR '1'='1`]) {
      await expect(handler.apply(job(aggregateId))).rejects.toBeInstanceOf(PermanentError);
    }
    expect(bumpCategoryProducts).not.toHaveBeenCalled();
  });
});
