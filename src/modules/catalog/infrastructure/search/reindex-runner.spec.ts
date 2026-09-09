import type { CatalogSearchPort, ProductRepositoryPort, SearchableProduct } from '../../application/ports';
import { Product } from '../../domain/entities';
import { reindexAll } from './reindex-runner';

// More reads than any fixture here needs: a cursor that fails to advance would page forever, and a
// thrown error names that better than a hung run does.
const RUNAWAY_READS = 20;

function product(id: string, createdAt: Date): Product {
  return new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], createdAt);
}

interface FakeRepository {
  repo: ProductRepositoryPort;
  cursorsRead: (string | null)[];
  /** Leaves the ACTIVE set mid-run, the way an archive would. */
  drop: (id: string) => void;
  /** Runs once a page has been read, so a test can mutate the set between pages. */
  hooks: { afterPage?: () => void };
}

function repositoryOf(total: number): FakeRepository {
  const cursorsRead: (string | null)[] = [];
  const hooks: { afterPage?: () => void } = {};
  // Zero-padded so the id order the scan follows is the insertion order the assertions read, the way
  // a uuidv7 sorts by creation time.
  const all = Array.from({ length: total }, (_, i) => product(`p${String(i).padStart(4, '0')}`, new Date(i * 1_000)));

  const repo = {
    findManyActive: () => Promise.resolve({ items: [], total: 0 }),
    findActiveAfter: (afterId: string | null, limit: number) => {
      cursorsRead.push(afterId);
      if (cursorsRead.length > RUNAWAY_READS) {
        throw new Error(`scan did not terminate after ${RUNAWAY_READS} reads`);
      }
      const page = (afterId === null ? [...all] : all.filter((candidate) => candidate.id > afterId)).slice(0, limit);
      hooks.afterPage?.();
      return Promise.resolve(page);
    },
    findActiveByIdOrSlug: () => Promise.resolve(null),
    findSkuView: () => Promise.resolve(null),
    findManySkuViews: () => Promise.resolve([]),
  } satisfies ProductRepositoryPort;

  return {
    repo,
    cursorsRead,
    hooks,
    drop: (id: string) => {
      const index = all.findIndex((candidate) => candidate.id === id);
      if (index >= 0) all.splice(index, 1);
    },
  };
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
    const { repo, cursorsRead } = repositoryOf(1_100);
    const { search, indexed } = searchSpy();

    const count = await reindexAll(repo, search);

    expect(count).toBe(1_100);
    expect(indexed.map((doc) => doc.id)).toHaveLength(1_100);
    expect(new Set(indexed.map((doc) => doc.id)).size).toBe(1_100);
    // Each page seeks from the previous page's last row instead of counting rows skipped.
    expect(cursorsRead).toEqual([null, 'p0499', 'p0999']);
  });

  it('stops at the first short page instead of asking for another', async () => {
    const { repo, cursorsRead } = repositoryOf(300);
    const { search } = searchSpy();

    await reindexAll(repo, search);

    expect(cursorsRead).toHaveLength(1);
  });

  // Without a total to stop on, a catalog that ends on a full page costs exactly one empty read.
  it('confirms the end with a single read when the last page is full', async () => {
    const { repo, cursorsRead } = repositoryOf(500);
    const { search } = searchSpy();

    expect(await reindexAll(repo, search)).toBe(500);
    expect(cursorsRead).toHaveLength(2);
  });

  it('still indexes every surviving product when one leaves the ACTIVE set mid-run', async () => {
    const { repo, drop, hooks } = repositoryOf(600);
    const { search, indexed } = searchSpy();
    // Archived out of the page already read, which under offset paging shifted p0500 past the scan.
    hooks.afterPage = () => {
      hooks.afterPage = undefined;
      drop('p0000');
    };

    await reindexAll(repo, search);

    const survivors = Array.from({ length: 599 }, (_, i) => `p${String(i + 1).padStart(4, '0')}`);
    expect(indexed.map((doc) => doc.id)).toEqual(expect.arrayContaining(survivors));
  });

  it('reports nothing indexed for an empty catalog', async () => {
    const { repo } = repositoryOf(0);
    const { search, calls } = searchSpy();

    expect(await reindexAll(repo, search)).toBe(0);
    expect(calls).toEqual(['ensureIndex']);
  });
});
