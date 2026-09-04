import type {
  CatalogSearchPort,
  FindManyActiveCriteria,
  ProductRepositoryPort,
  SearchableProduct,
} from '../../application/ports';
import { Product } from '../../domain/entities';
import { reindexAll } from './reindex-runner';

function product(id: string): Product {
  return new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0));
}

// Serves `total` products across as many pages as the caller's pageSize implies.
function repositoryOf(total: number): { repo: ProductRepositoryPort; pagesRead: FindManyActiveCriteria[] } {
  const pagesRead: FindManyActiveCriteria[] = [];
  const all = Array.from({ length: total }, (_, i) => product(`p${i}`));

  const repo = {
    findManyActive: (criteria: FindManyActiveCriteria) => {
      pagesRead.push(criteria);
      const start = (criteria.page - 1) * criteria.pageSize;
      return Promise.resolve({ items: all.slice(start, start + criteria.pageSize), total });
    },
    findActiveByIdOrSlug: () => Promise.resolve(null),
    findSkuView: () => Promise.resolve(null),
    findManySkuViews: () => Promise.resolve([]),
  } satisfies ProductRepositoryPort;

  return { repo, pagesRead };
}

function searchSpy(): { search: CatalogSearchPort; calls: string[]; indexed: SearchableProduct[] } {
  const calls: string[] = [];
  const indexed: SearchableProduct[] = [];

  const search = {
    ensureIndex: () => {
      calls.push('ensureIndex');
      return Promise.resolve();
    },
    resetIndex: () => {
      calls.push('resetIndex');
      return Promise.resolve();
    },
    bulkIndex: (docs: SearchableProduct[]) => {
      calls.push(`bulkIndex:${docs.length}`);
      indexed.push(...docs);
      return Promise.resolve();
    },
    indexProduct: () => Promise.resolve(),
    deleteProduct: () => Promise.resolve(),
    search: () => Promise.resolve({ items: [], total: 0 }),
  } satisfies CatalogSearchPort;

  return { search, calls, indexed };
}

describe('reindexAll', () => {
  it('applies the index settings before loading anything into it', async () => {
    const { repo } = repositoryOf(1);
    const { search, calls } = searchSpy();

    await reindexAll(repo, search);

    expect(calls[0]).toBe('ensureIndex');
  });

  it('leaves existing documents in place by default', async () => {
    const { repo } = repositoryOf(1);
    const { search, calls } = searchSpy();

    await reindexAll(repo, search);

    expect(calls).not.toContain('resetIndex');
  });

  // Ordered, not merely present: clearing after the load would wipe what was just written.
  it('clears the index before loading when asked to reset', async () => {
    const { repo } = repositoryOf(1);
    const { search, calls } = searchSpy();

    await reindexAll(repo, search, { reset: true });

    expect(calls.indexOf('resetIndex')).toBeLessThan(calls.indexOf('bulkIndex:1'));
  });

  it('pages through a catalog larger than one read and indexes every product once', async () => {
    const { repo, pagesRead } = repositoryOf(1_100);
    const { search, indexed } = searchSpy();

    const count = await reindexAll(repo, search);

    expect(count).toBe(1_100);
    expect(indexed.map((doc) => doc.id)).toHaveLength(1_100);
    expect(new Set(indexed.map((doc) => doc.id)).size).toBe(1_100);
    expect(pagesRead.map((criteria) => criteria.page)).toEqual([1, 2, 3]);
  });

  it('stops at the reported total instead of asking for a page past the end', async () => {
    const { repo, pagesRead } = repositoryOf(500);
    const { search } = searchSpy();

    await reindexAll(repo, search);

    expect(pagesRead).toHaveLength(1);
  });

  it('reports nothing indexed for an empty catalog', async () => {
    const { repo } = repositoryOf(0);
    const { search, calls } = searchSpy();

    expect(await reindexAll(repo, search)).toBe(0);
    expect(calls).toEqual(['ensureIndex']);
  });
});
