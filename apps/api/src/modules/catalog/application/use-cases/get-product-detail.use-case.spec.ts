import { NotFoundException } from '@nestjs/common';
import { Product } from '../../domain/entities';
import type { FindManyActiveResult, MediaQueryPort, ProductRepositoryPort } from '../ports';
import { GetProductDetailUseCase } from './get-product-detail.use-case';

class MockMediaQuery implements MediaQueryPort {
  urls = new Map<string, string>();
  lastArg?: string[];

  resolveUrls(assetIds: string[]): Promise<Map<string, string>> {
    this.lastArg = assetIds;
    return Promise.resolve(this.urls);
  }
}

class MockProductRepository implements ProductRepositoryPort {
  detailResult: Product | null = null;
  lastArg?: string;

  findManyActive(): Promise<FindManyActiveResult> {
    return Promise.resolve({ items: [], total: 0 });
  }

  findActiveAfter(): Promise<Product[]> {
    return Promise.resolve([]);
  }

  findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null> {
    this.lastArg = idOrSlug;
    return Promise.resolve(this.detailResult);
  }

  findSkuView(): Promise<null> {
    return Promise.resolve(null);
  }

  findManySkuViews(): Promise<[]> {
    return Promise.resolve([]);
  }
}

describe('GetProductDetailUseCase', () => {
  let repo: MockProductRepository;
  let media: MockMediaQuery;
  let useCase: GetProductDetailUseCase;

  beforeEach(() => {
    repo = new MockProductRepository();
    media = new MockMediaQuery();
    useCase = new GetProductDetailUseCase(repo, media);
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

    await expect(useCase.execute('headphones')).resolves.toMatchObject({ product: found });
    expect(repo.lastArg).toBe('headphones');
  });

  it('resolves URLs for the product image assets', async () => {
    repo.detailResult = new Product(
      'p1',
      'Headphones',
      'headphones',
      null,
      'ACTIVE',
      { slug: 'electronics', name: 'Electronics' },
      [],
      new Date(0),
      ['asset-1'],
    );
    media.urls = new Map([['asset-1', 'https://cdn.example/asset-1']]);

    const result = await useCase.execute('headphones');

    expect(media.lastArg).toEqual(['asset-1']);
    expect(result.imageUrls.get('asset-1')).toBe('https://cdn.example/asset-1');
  });

  it('throws NotFoundException when the product is absent', async () => {
    repo.detailResult = null;

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
