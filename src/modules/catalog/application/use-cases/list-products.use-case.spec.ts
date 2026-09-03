import { Product } from '../../domain/entities';
import type { FindManyActiveCriteria, FindManyActiveResult, ProductRepositoryPort } from '../ports';
import { ListProductsUseCase } from './list-products.use-case';

class MockProductRepository implements ProductRepositoryPort {
  manyResult: FindManyActiveResult = { items: [], total: 0 };
  lastCriteria?: FindManyActiveCriteria;

  findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult> {
    this.lastCriteria = criteria;
    return Promise.resolve(this.manyResult);
  }

  findActiveByIdOrSlug(): Promise<Product | null> {
    return Promise.resolve(null);
  }

  // Unused by this use-case; present to satisfy the read port.
  findSkuView(): Promise<null> {
    return Promise.resolve(null);
  }

  findManySkuViews(): Promise<[]> {
    return Promise.resolve([]);
  }
}

function product(id: string): Product {
  return new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0));
}

describe('ListProductsUseCase', () => {
  let repo: MockProductRepository;
  let useCase: ListProductsUseCase;

  beforeEach(() => {
    repo = new MockProductRepository();
    useCase = new ListProductsUseCase(repo);
  });

  it('computes totalPages by ceiling(total / pageSize)', async () => {
    repo.manyResult = { items: [product('a')], total: 25 };

    const result = await useCase.execute({ page: 2, pageSize: 10 });

    expect(result.totalPages).toBe(3);
    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.items).toHaveLength(1);
  });

  it('returns 0 totalPages when there are no matches', async () => {
    repo.manyResult = { items: [], total: 0 };

    const result = await useCase.execute({ page: 1, pageSize: 20 });

    expect(result.totalPages).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('returns 1 page when total fits exactly in one page', async () => {
    repo.manyResult = { items: [product('a'), product('b')], total: 20 };

    const result = await useCase.execute({ page: 1, pageSize: 20 });

    expect(result.totalPages).toBe(1);
  });

  it('passes the criteria (filters included) through to the repository', async () => {
    await useCase.execute({
      page: 1,
      pageSize: 20,
      categorySlug: 'electronics',
      q: 'phone',
    });

    expect(repo.lastCriteria).toEqual({
      page: 1,
      pageSize: 20,
      categorySlug: 'electronics',
      q: 'phone',
    });
  });
});
