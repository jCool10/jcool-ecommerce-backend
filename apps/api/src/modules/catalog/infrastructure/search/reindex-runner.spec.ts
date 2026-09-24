import type { CatalogSearchPort, ProductRepositoryPort, SearchableProduct } from '../../application/ports';
import { Product } from '../../domain/entities';
import { fakeCatalogSearch, fakeProductRepository } from '../../testing/catalog-port.doubles';
import { reindexAll } from './reindex-runner';

// More reads than any fixture here needs: a cursor that fails to advance would page forever, and a
// thrown error names that better than a hung run does.
const RUNAWAY_READS = 20;

function product(id: string): Product {
  return new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0));
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
  // Zero-padded so id order is insertion order, the way a uuidv7 sorts by creation time.
  const all = Array.from({ length: total }, (_, i) => product(`p${String(i).padStart(4, '0')}`));

  const repo = fakeProductRepository({
    findActiveAfter: (afterId, limit) => {
      cursorsRead.push(afterId);
      if (cursorsRead.length > RUNAWAY_READS) {
        throw new Error(`scan did not terminate after ${RUNAWAY_READS} reads`);
      }
      const page = (afterId === null ? [...all] : all.filter((candidate) => candidate.id > afterId)).slice(0, limit);
      hooks.afterPage?.();
      return Promise.resolve(page);
    },
  });

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

  const search = fakeCatalogSearch({
    ensureIndex: () => {
      calls.push('ensureIndex');
      return Promise.resolve();
    },
    resetIndex: () => {
      calls.push('resetIndex');
      return Promise.resolve();
    },
    bulkIndex: (docs) => {
      calls.push(`bulkIndex:${docs.length}`);
      indexed.push(...docs);
      return Promise.resolve();
    },
  });

  return { search, calls, indexed };
}

describe('reindexAll', () => {
  // Clearing after the load would wipe what was just written.
  it('applies the settings, then clears on reset, before loading anything', async () => {
    const { repo } = repositoryOf(1);
    const plain = searchSpy();
    const reset = searchSpy();

    await reindexAll(repo, plain.search);
    await reindexAll(repo, reset.search, { reset: true });

    expect(plain.calls).toEqual(['ensureIndex', 'bulkIndex:1']);
    expect(reset.calls).toEqual(['ensureIndex', 'resetIndex', 'bulkIndex:1']);
  });

  it('pages through a catalog larger than one read and indexes every product once', async () => {
    const { repo, cursorsRead } = repositoryOf(1_100);
    const { search, indexed } = searchSpy();

    const count = await reindexAll(repo, search);

    expect(count).toBe(1_100);
    expect(new Set(indexed.map((doc) => doc.id)).size).toBe(1_100);
    // Each page seeks from the previous page's last row instead of counting rows skipped.
    expect(cursorsRead).toEqual([null, 'p0499', 'p0999']);
  });

  // With no total to stop on, only a catalog that ends on a full page costs one extra empty read.
  it('stops after a short page, or one empty read past a full one', async () => {
    const reads = await Promise.all(
      [0, 300, 500].map(async (total) => {
        const { repo, cursorsRead } = repositoryOf(total);
        const indexedCount = await reindexAll(repo, searchSpy().search);
        return { total, indexedCount, reads: cursorsRead.length };
      }),
    );

    expect(reads).toEqual([
      { total: 0, indexedCount: 0, reads: 1 },
      { total: 300, indexedCount: 300, reads: 1 },
      { total: 500, indexedCount: 500, reads: 2 },
    ]);
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
});
