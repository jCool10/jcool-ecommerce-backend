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

  describe('syncCategory', () => {
    const CATEGORY_ID = '0198f0d8-3333-7000-8000-0000000000c1';
    const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((suffix) => `0198f0d8-3333-7000-8000-00000000000${suffix}`);
    const tombstone = (id: string) => ({ id, version: 5, doc: null });

    function buildFanOut(pages: string[][], write = vi.fn<CatalogSearchPort['write']>().mockResolvedValue()) {
      const bumpCategoryProducts = vi.fn<ProductSearchStatePort['bumpCategoryProducts']>().mockResolvedValue([]);
      for (const page of pages) bumpCategoryProducts.mockResolvedValueOnce(page);
      const findByIds = vi
        .fn<ProductSearchStatePort['findByIds']>()
        .mockImplementation((ids) => Promise.resolve(ids.map((id) => ({ id, version: 5, product: null }))));
      const service = new ProductSearchSyncService(
        fakeProductSearchState({ bumpCategoryProducts, findByIds }),
        fakeCatalogSearch({ write }),
        fakePinoLogger(),
      );
      return { service, bumpCategoryProducts, findByIds, write };
    }

    it('bumps and writes the category page by page, resuming after the last id of each page', async () => {
      const { service, bumpCategoryProducts, findByIds, write } = buildFanOut([[A, B], [C]]);

      await expect(service.syncCategory(CATEGORY_ID, 2)).resolves.toBe(3);

      expect(bumpCategoryProducts.mock.calls).toEqual([
        [CATEGORY_ID, null, 2],
        [CATEGORY_ID, B, 2],
        [CATEGORY_ID, C, 2],
      ]);
      expect(findByIds.mock.calls).toEqual([[[A, B]], [[C]]]);
      expect(write.mock.calls).toEqual([[[tombstone(A), tombstone(B)]], [[tombstone(C)]]]);
    });

    it('writes nothing for a category without products, paging 500 at a time by default', async () => {
      const { service, bumpCategoryProducts, write } = buildFanOut([]);

      await expect(service.syncCategory(CATEGORY_ID)).resolves.toBe(0);

      expect(bumpCategoryProducts.mock.calls).toEqual([[CATEGORY_ID, null, 500]]);
      expect(write).not.toHaveBeenCalled();
    });

    it('stops at the page whose write fails and rejects with the engine error', async () => {
      const outage = new Error('search engine unavailable');
      const { service, bumpCategoryProducts, write } = buildFanOut(
        [
          [A, B],
          [C, D],
        ],
        vi.fn<CatalogSearchPort['write']>().mockResolvedValueOnce().mockRejectedValueOnce(outage),
      );

      await expect(service.syncCategory(CATEGORY_ID, 2)).rejects.toBe(outage);

      expect(write).toHaveBeenCalledTimes(2);
      expect(bumpCategoryProducts).toHaveBeenCalledTimes(2);
    });
  });
});
