import type { CatalogSearchPort, SearchCriteria, SearchHit, SearchResult, SearchableProduct } from '../ports';
import { SearchProductsUseCase } from './search-products.use-case';

class MockCatalogSearch implements CatalogSearchPort {
  result: SearchResult = { items: [], total: 0 };
  lastCriteria?: SearchCriteria;

  search(criteria: SearchCriteria): Promise<SearchResult> {
    this.lastCriteria = criteria;
    return Promise.resolve(this.result);
  }

  ensureIndex(): Promise<void> {
    return Promise.resolve();
  }

  resetIndex(): Promise<void> {
    return Promise.resolve();
  }

  bulkIndex(_docs: SearchableProduct[]): Promise<void> {
    return Promise.resolve();
  }

  indexProduct(_doc: SearchableProduct): Promise<void> {
    return Promise.resolve();
  }

  deleteProduct(_id: string): Promise<void> {
    return Promise.resolve();
  }
}

function hit(id: string): SearchHit {
  return { id, name: `Product ${id}`, slug: id, categorySlug: 'c', minPriceMinor: 1000, currency: 'VND' };
}

describe('SearchProductsUseCase', () => {
  let search: MockCatalogSearch;
  let useCase: SearchProductsUseCase;

  beforeEach(() => {
    search = new MockCatalogSearch();
    useCase = new SearchProductsUseCase(search);
  });

  it('computes totalPages by ceiling(total / pageSize)', async () => {
    search.result = { items: [hit('a')], total: 25 };

    const result = await useCase.execute({ q: 'phone', page: 2, pageSize: 10 });

    expect(result.totalPages).toBe(3);
    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.items).toHaveLength(1);
  });

  it('returns 1 page when total fits exactly in one page', async () => {
    search.result = { items: [hit('a'), hit('b')], total: 20 };

    const result = await useCase.execute({ q: 'phone', page: 1, pageSize: 20 });

    expect(result.totalPages).toBe(1);
  });

  it('passes the criteria (filters included) through to the port', async () => {
    await useCase.execute({ q: 'phone', page: 1, pageSize: 20, categorySlug: 'electronics' });

    expect(search.lastCriteria).toEqual({
      q: 'phone',
      page: 1,
      pageSize: 20,
      categorySlug: 'electronics',
    });
  });

  // Also the degraded path: the adapter answers a down engine with an empty result, not a throw.
  it('reports an empty page rather than failing when the port returns nothing', async () => {
    search.result = { items: [], total: 0 };

    const result = await useCase.execute({ q: 'phone', page: 1, pageSize: 20 });

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
  });
});
