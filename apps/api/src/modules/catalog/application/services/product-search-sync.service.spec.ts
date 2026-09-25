import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Product } from '../../domain/entities';
import { fakeCatalogSearch, fakeProductSearchState } from '../../testing/catalog-port.doubles';
import { toSearchableProduct } from '../catalog-search.mapper';
import type { CatalogSearchPort, ProductSearchState, ProductSearchStatePort } from '../ports';
import { ProductSearchSyncService } from './product-search-sync.service';

const PRODUCT_ID = '0198f0d8-3333-7000-8000-000000000001';

const lantern = new Product(
  PRODUCT_ID,
  'Harbor Lantern',
  'harbor-lantern',
  'Brass, storm-proof',
  'ACTIVE',
  { slug: 'lighting', name: 'Lighting' },
  [],
  new Date('2026-09-01T00:00:00.000Z'),
);

function build(states: ProductSearchState[], write = vi.fn<CatalogSearchPort['write']>().mockResolvedValue()) {
  const findByIds = vi.fn<ProductSearchStatePort['findByIds']>().mockResolvedValue(states);
  const warn = vi.fn();
  const service = new ProductSearchSyncService(
    fakeProductSearchState({ findByIds }),
    fakeCatalogSearch({ write }),
    fakePinoLogger({ warn }),
  );
  return { service, findByIds, write, warn };
}

describe('ProductSearchSyncService', () => {
  it('writes a visible product under the version it was read at', async () => {
    const { service, findByIds, write } = build([{ id: PRODUCT_ID, version: 7, product: lantern }]);

    await service.syncProduct(PRODUCT_ID);

    expect(findByIds).toHaveBeenCalledWith([PRODUCT_ID]);
    expect(write).toHaveBeenCalledWith([{ id: PRODUCT_ID, version: 7, doc: toSearchableProduct(lantern) }]);
  });

  it('writes a tombstone for a product that left the public projection', async () => {
    const { service, write } = build([{ id: PRODUCT_ID, version: 8, product: null }]);

    await service.syncProduct(PRODUCT_ID);

    expect(write).toHaveBeenCalledWith([{ id: PRODUCT_ID, version: 8, doc: null }]);
  });

  it('writes nothing for a product it cannot find and says which one', async () => {
    const { service, findByIds, write, warn } = build([]);

    await service.syncProduct(PRODUCT_ID);

    expect(findByIds).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({ productId: PRODUCT_ID }, expect.any(String));
    expect(write).not.toHaveBeenCalled();
  });

  // Swallowed, the consumer would claim the event and the change would never reach the index.
  it('rejects with the engine error so the delivery is retried', async () => {
    const outage = new Error('search engine unavailable');
    const { service } = build(
      [{ id: PRODUCT_ID, version: 9, product: lantern }],
      vi.fn<CatalogSearchPort['write']>().mockRejectedValue(outage),
    );

    await expect(service.syncProduct(PRODUCT_ID)).rejects.toBe(outage);
  });
});
