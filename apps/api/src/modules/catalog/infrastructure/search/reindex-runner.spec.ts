import {
  type CatalogSearchPort,
  type ProductSearchState,
  type ProductSearchStatePort,
  RebuildInProgressError,
  type SearchDocumentWrite,
} from '../../application/ports';
import { Product } from '../../domain/entities';
import { fakeCatalogSearch, fakeProductSearchState } from '../../testing/catalog-port.doubles';
import { rebuildIndex } from './reindex-runner';

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

const REBUILD = 'products_v9';
const RETIRED = ['products_v0', 'products_v7'];

/** Records every engine call in order; `overrides` replace the recorded answers. */
function searchSpy(overrides: Partial<CatalogSearchPort> = {}) {
  const calls: string[] = [];
  const written: SearchDocumentWrite[] = [];
  const record =
    <A extends unknown[], R>(name: (...args: A) => string, answer: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push(name(...args));
      return answer(...args);
    };

  const search = fakeCatalogSearch({
    write: record(
      () => 'write',
      () => Promise.resolve(),
    ),
    beginRebuild: record(() => 'begin', overrides.beginRebuild ?? (() => Promise.resolve(REBUILD))),
    writeRebuild: record(
      (changes) => `writeRebuild:${changes.length}`,
      overrides.writeRebuild ??
        ((changes) => {
          written.push(...changes);
          return Promise.resolve();
        }),
    ),
    promoteRebuild: record(
      (rebuild: string) => `promote:${rebuild}`,
      overrides.promoteRebuild ?? (() => Promise.resolve(RETIRED)),
    ),
    abortRebuild: record((rebuild?: string) => `abort:${rebuild}`, overrides.abortRebuild ?? (() => Promise.resolve())),
    dropRetired: record(
      (indices: string[]) => `dropRetired:${indices.join(',')}`,
      () => Promise.resolve(),
    ),
  });
  const sleep = (ms: number) => {
    calls.push(`sleep:${ms}`);
    return Promise.resolve();
  };
  return { search, sleep, calls, written };
}

describe('rebuildIndex', () => {
  it('fills the new index page by page, swaps search onto it, and drops the retired indices after the grace', async () => {
    const { states } = statesOf(5);
    const { search, sleep, calls } = searchSpy();

    const result = await rebuildIndex(states, search, { pageSize: 2, graceMs: 250, sleep });

    expect(calls).toEqual([
      'begin',
      'writeRebuild:2',
      'writeRebuild:2',
      'writeRebuild:1',
      `promote:${REBUILD}`,
      'sleep:250',
      `dropRetired:${RETIRED.join(',')}`,
    ]);
    expect(result).toEqual({ documents: 3, tombstones: 2, retired: RETIRED });
  });

  it('fills every product, tombstones included, at its row version', async () => {
    const { states, cursorsRead } = statesOf(1_100);
    const { search, sleep, written } = searchSpy();

    const { documents, tombstones } = await rebuildIndex(states, search, { sleep });

    // Each page seeks from the previous page's last row instead of counting rows skipped.
    expect(cursorsRead).toEqual([null, 'p0499', 'p0999']);
    expect(written.map((change) => change.id)).toEqual(Array.from({ length: 1_100 }, (_, i) => idOf(i)));
    expect(written[4]).toMatchObject({ id: 'p0004', version: 4, doc: { id: 'p0004' } });
    expect(written[3]).toEqual({ id: 'p0003', version: 3, doc: null });
    expect({ documents, tombstones }).toEqual({ documents: 733, tombstones: 367 });
  });

  // With no total to stop on, only a catalog that ends on a full page costs one extra empty read.
  it('stops after a short page, or one empty read past a full one', async () => {
    const reads = await Promise.all(
      [0, 300, 500].map(async (total) => {
        const { states, cursorsRead } = statesOf(total);
        const { search, sleep } = searchSpy();
        const { documents, tombstones } = await rebuildIndex(states, search, { sleep });
        return { total, written: documents + tombstones, reads: cursorsRead.length };
      }),
    );

    expect(reads).toEqual([
      { total: 0, written: 0, reads: 1 },
      { total: 300, written: 300, reads: 1 },
      { total: 500, written: 500, reads: 2 },
    ]);
  });

  it('waits 30 seconds before dropping the retired indices unless told otherwise', async () => {
    const { states } = statesOf(1);
    const { search, sleep, calls } = searchSpy();

    await rebuildIndex(states, search, { sleep });

    expect(calls).toContain('sleep:30000');
  });

  it('aborts on a failed page, never swaps, and rejects with the failure', async () => {
    const { states } = statesOf(5);
    const failure = new Error('bulk refused');
    let pages = 0;
    const { search, sleep, calls } = searchSpy({
      writeRebuild: () => (++pages === 2 ? Promise.reject(failure) : Promise.resolve()),
    });

    await expect(rebuildIndex(states, search, { pageSize: 2, sleep })).rejects.toBe(failure);

    expect(calls).toEqual(['begin', 'writeRebuild:2', 'writeRebuild:2', `abort:${REBUILD}`]);
  });

  it('aborts when the swap fails', async () => {
    const { states } = statesOf(1);
    const failure = new Error('alias swap refused');
    const { search, sleep, calls } = searchSpy({ promoteRebuild: () => Promise.reject(failure) });

    await expect(rebuildIndex(states, search, { sleep })).rejects.toBe(failure);

    expect(calls).toEqual(['begin', 'writeRebuild:1', `promote:${REBUILD}`, `abort:${REBUILD}`]);
  });

  it('stops between pages once interrupted, and aborts', async () => {
    const { states } = statesOf(5);
    const interrupt = new AbortController();
    const reason = new Error('interrupted by SIGINT');
    const { search, sleep, calls } = searchSpy({
      writeRebuild: () => {
        interrupt.abort(reason);
        return Promise.resolve();
      },
    });

    await expect(rebuildIndex(states, search, { pageSize: 2, sleep, signal: interrupt.signal })).rejects.toBe(reason);

    expect(calls).toEqual(['begin', 'writeRebuild:2', `abort:${REBUILD}`]);
  });

  it('reports the failure and the failed abort together', async () => {
    const { states } = statesOf(1);
    const failure = new Error('bulk refused');
    const abortFailure = new Error('engine unreachable');
    const { search, sleep } = searchSpy({
      writeRebuild: () => Promise.reject(failure),
      abortRebuild: () => Promise.reject(abortFailure),
    });

    const rejection = rebuildIndex(states, search, { sleep });

    await expect(rejection).rejects.toBeInstanceOf(AggregateError);
    await expect(rejection).rejects.toMatchObject({ errors: [failure, abortFailure] });
  });

  // The lock belongs to the other run: aborting would delete the index it is filling.
  it('touches nothing when another rebuild holds the lock', async () => {
    const { states, cursorsRead } = statesOf(3);
    const { search, sleep, calls } = searchSpy({ beginRebuild: () => Promise.reject(new RebuildInProgressError()) });

    await expect(rebuildIndex(states, search, { sleep })).rejects.toBeInstanceOf(RebuildInProgressError);

    expect(calls).toEqual(['begin']);
    expect(cursorsRead).toEqual([]);
  });
});
