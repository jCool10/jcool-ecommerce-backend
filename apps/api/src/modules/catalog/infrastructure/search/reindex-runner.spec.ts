import type {
  CatalogSearchPort,
  ProductSearchState,
  ProductSearchStatePort,
  SearchDocumentWrite,
} from '../../application/ports';
import { Product } from '../../domain/entities';
import { fakeCatalogSearch, fakeProductSearchState } from '../../testing/catalog-port.doubles';
import { reindexAll } from './reindex-runner';

// More reads than any fixture here needs: a cursor that fails to advance would page forever, and a
// thrown error names that better than a hung run does.
const RUNAWAY_READS = 20;

// Zero-padded so id order is insertion order, the way a uuidv7 sorts by creation time.
const idOf = (i: number): string => `p${String(i).padStart(4, '0')}`;

// Every third product is outside the public projection, so pages mix documents and tombstones.
function stateOf(i: number): ProductSearchState {
  const id = idOf(i);
  const product =
    i % 3 === 0
      ? null
      : new Product(id, `Product ${id}`, id, null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0));
  return { id, version: i, product };
}

function statesOf(total: number): { states: ProductSearchStatePort; cursorsRead: (string | null)[] } {
  const cursorsRead: (string | null)[] = [];
  const all = Array.from({ length: total }, (_, i) => stateOf(i));

  const states = fakeProductSearchState({
    findByIds: () => Promise.reject(new Error('a rebuild pages by cursor')),
    findAfter: (afterId, limit) => {
      cursorsRead.push(afterId);
      if (cursorsRead.length > RUNAWAY_READS) {
        throw new Error(`scan did not terminate after ${RUNAWAY_READS} reads`);
      }
      return Promise.resolve(all.filter((entry) => afterId === null || entry.id > afterId).slice(0, limit));
    },
  });
  return { states, cursorsRead };
}

function searchSpy(): { search: CatalogSearchPort; calls: string[]; written: SearchDocumentWrite[] } {
  const calls: string[] = [];
  const written: SearchDocumentWrite[] = [];

  const search = fakeCatalogSearch({
    ensureIndex: () => {
      calls.push('ensureIndex');
      return Promise.resolve();
    },
    write: (changes) => {
      calls.push(`write:${changes.length}`);
      written.push(...changes);
      return Promise.resolve();
    },
  });

  return { search, calls, written };
}

describe('reindexAll', () => {
  it('ensures the index before writing anything', async () => {
    const { states } = statesOf(2);
    const { search, calls } = searchSpy();

    await reindexAll(states, search);

    expect(calls).toEqual(['ensureIndex', 'write:2']);
  });

  it('writes every page, tombstones included, at each row version and counts both', async () => {
    const { states, cursorsRead } = statesOf(1_100);
    const { search, written } = searchSpy();

    const counts = await reindexAll(states, search);

    // Each page seeks from the previous page's last row instead of counting rows skipped.
    expect(cursorsRead).toEqual([null, 'p0499', 'p0999']);
    expect(written.map((change) => change.id)).toEqual(Array.from({ length: 1_100 }, (_, i) => idOf(i)));
    expect(written[4]).toMatchObject({ id: 'p0004', version: 4, doc: { id: 'p0004' } });
    expect(written[3]).toEqual({ id: 'p0003', version: 3, doc: null });
    expect(counts).toEqual({ documents: 733, tombstones: 367 });
  });

  // With no total to stop on, only a catalog that ends on a full page costs one extra empty read.
  it('stops after a short page, or one empty read past a full one', async () => {
    const reads = await Promise.all(
      [0, 300, 500].map(async (total) => {
        const { states, cursorsRead } = statesOf(total);
        const { documents, tombstones } = await reindexAll(states, searchSpy().search);
        return { total, written: documents + tombstones, reads: cursorsRead.length };
      }),
    );

    expect(reads).toEqual([
      { total: 0, written: 0, reads: 1 },
      { total: 300, written: 300, reads: 1 },
      { total: 500, written: 500, reads: 2 },
    ]);
  });
});
