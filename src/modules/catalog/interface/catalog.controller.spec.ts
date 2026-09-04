import type { SearchCriteria } from '../application/ports';
import type { GetProductDetailUseCase, ListProductsUseCase, SearchProductsUseCase } from '../application/use-cases';
import { CatalogController } from './catalog.controller';
import { SearchProductsQueryDto } from './dto';

function query(overrides: Partial<SearchProductsQueryDto>): SearchProductsQueryDto {
  return Object.assign(new SearchProductsQueryDto(), { q: 'headphones' }, overrides);
}

describe('CatalogController (search)', () => {
  let criteria: SearchCriteria | undefined;
  let controller: CatalogController;

  beforeEach(() => {
    criteria = undefined;
    const searchProducts = {
      execute: (received: SearchCriteria) => {
        criteria = received;
        return Promise.resolve({
          items: [
            {
              id: 'p1',
              name: 'Wireless Headphones',
              slug: 'wireless-headphones',
              categorySlug: 'audio',
              minPriceMinor: 2_490_000,
              currency: 'VND',
              highlight: { name: 'Wireless <em>Headphones</em>' },
            },
          ],
          total: 1,
          page: received.page,
          pageSize: received.pageSize,
          totalPages: 1,
        });
      },
    } as unknown as SearchProductsUseCase;

    controller = new CatalogController({} as ListProductsUseCase, {} as GetProductDetailUseCase, searchProducts);
  });

  // The category filter is the one query param with no effect the caller can see in the envelope, so
  // dropping it on the way to the use case would silently widen every filtered search.
  it('forwards every query param, the category filter included', async () => {
    await controller.search(query({ page: 2, pageSize: 5, categorySlug: 'audio' }));

    expect(criteria).toEqual({ q: 'headphones', page: 2, pageSize: 5, categorySlug: 'audio' });
  });

  it('leaves the category filter unset when the caller omitted it', async () => {
    await controller.search(query({}));

    expect(criteria?.categorySlug).toBeUndefined();
  });

  it('maps hits into the response envelope', async () => {
    const response = await controller.search(query({}));

    expect(response.total).toBe(1);
    expect(response.totalPages).toBe(1);
    expect(response.items).toEqual([
      {
        id: 'p1',
        name: 'Wireless Headphones',
        slug: 'wireless-headphones',
        categorySlug: 'audio',
        minPriceMinor: 2_490_000,
        currency: 'VND',
        highlight: { name: 'Wireless <em>Headphones</em>' },
      },
    ]);
  });
});
