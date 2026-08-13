import { NotFoundException } from '@nestjs/common';
import { Product } from '../../domain/entities';
import type { FindManyActiveResult, ProductRepositoryPort } from '../ports';
import { GetProductDetailUseCase } from './get-product-detail.use-case';

class MockProductRepository implements ProductRepositoryPort {
  detailResult: Product | null = null;
  lastArg?: string;

  findManyActive(): Promise<FindManyActiveResult> {
    return Promise.resolve({ items: [], total: 0 });
  }

  findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null> {
    this.lastArg = idOrSlug;
    return Promise.resolve(this.detailResult);
  }
}

describe('GetProductDetailUseCase', () => {
  let repo: MockProductRepository;
  let useCase: GetProductDetailUseCase;

  beforeEach(() => {
    repo = new MockProductRepository();
    useCase = new GetProductDetailUseCase(repo);
  });

  it('returns the product when found', async () => {
    const found = new Product(
      'p1',
      'Headphones',
      'headphones',
      'desc',
      'ACTIVE',
      { slug: 'electronics', name: 'Electronics' },
      [],
      new Date(0),
    );
    repo.detailResult = found;

    await expect(useCase.execute('headphones')).resolves.toBe(found);
    expect(repo.lastArg).toBe('headphones');
  });

  it('throws NotFoundException when the product is absent', async () => {
    repo.detailResult = null;

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
