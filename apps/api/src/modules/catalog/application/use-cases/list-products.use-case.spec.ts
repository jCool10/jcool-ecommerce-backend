import { Product } from '../../domain/entities';
import { fakeProductRepository } from '../../testing/catalog-port.doubles';
import type { FindManyActiveResult, MediaQueryPort } from '../ports';
import { ListProductsUseCase } from './list-products.use-case';

function product(id: string, imageAssetIds: string[] = []): Product {
  return new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0), imageAssetIds);
}

function build(
  result: FindManyActiveResult,
  media: MediaQueryPort = { resolveUrls: () => Promise.resolve(new Map()) },
) {
  return new ListProductsUseCase(fakeProductRepository({ findManyActive: () => Promise.resolve(result) }), media);
}

describe('ListProductsUseCase', () => {
  it('reports totalPages as the ceiling of total over pageSize', async () => {
    const cases = [
      { total: 25, pageSize: 10 },
      { total: 20, pageSize: 20 },
      { total: 0, pageSize: 20 },
    ];

    const pages = await Promise.all(
      cases.map(async ({ total, pageSize }) => {
        const result = await build({ items: [], total }).execute({ page: 1, pageSize });
        return result.totalPages;
      }),
    );

    expect(pages).toEqual([3, 1, 0]);
  });

  it('resolves the image URLs for the whole page in one call', async () => {
    const calls: string[][] = [];
    const media: MediaQueryPort = {
      resolveUrls: (assetIds) => {
        calls.push(assetIds);
        return Promise.resolve(new Map());
      },
    };

    await build({ items: [product('a', ['x']), product('b', ['y', 'z'])], total: 2 }, media).execute({
      page: 1,
      pageSize: 20,
    });

    expect(calls).toEqual([['x', 'y', 'z']]);
  });
});
