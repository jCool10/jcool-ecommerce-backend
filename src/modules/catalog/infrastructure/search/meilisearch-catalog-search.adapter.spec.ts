import type { ConfigService } from '@nestjs/config';
import type { SearchableProduct } from '../../application/ports';
import { MeilisearchCatalogSearch } from './meilisearch-catalog-search.adapter';

function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

const DOC: SearchableProduct = {
  id: 'p1',
  name: 'Widget',
  slug: 'widget',
  description: null,
  categorySlug: 'tools',
  categoryName: 'Tools',
  status: 'ACTIVE',
  skus: ['WIDGET-1'],
  minPriceMinor: 1000,
  currency: 'VND',
  createdAtEpoch: 0,
};

// SEARCH_ENABLED=false: no client is built, so every method short-circuits without touching an
// engine — the property that lets dev and unit runs skip Meilisearch entirely.
describe('MeilisearchCatalogSearch (disabled)', () => {
  const adapter = new MeilisearchCatalogSearch(configStub({ 'search.enabled': false }));

  it('search resolves to an empty result', async () => {
    await expect(adapter.search({ q: 'anything', page: 1, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it('write methods resolve as no-ops', async () => {
    await expect(adapter.ensureIndex()).resolves.toBeUndefined();
    await expect(adapter.indexProduct(DOC)).resolves.toBeUndefined();
    await expect(adapter.bulkIndex([DOC])).resolves.toBeUndefined();
    await expect(adapter.deleteProduct('p1')).resolves.toBeUndefined();
  });
});
