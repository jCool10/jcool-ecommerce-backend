import { describe, expect, it, vi } from 'vitest';
import { publishSkuSnapshots, type SkuSnapshotPages } from './publish-sku-snapshots-runner';

function catalogOf(productIds: string[], onAppend: () => void = () => undefined) {
  const appended: { productIds: string[]; outboxIds: string[] }[] = [];
  const productIdsAfter = vi.fn((afterId: string | null, limit: number) => {
    const start = afterId === null ? 0 : productIds.indexOf(afterId) + 1;
    return Promise.resolve(productIds.slice(start, start + limit));
  });
  const pages: SkuSnapshotPages = {
    productIdsAfter,
    appendPage: (ids, outboxIds) => {
      appended.push({ productIds: [...ids], outboxIds: [...outboxIds] });
      onAppend();
      return Promise.resolve();
    },
  };
  return { pages, appended, productIdsAfter };
}

function sequentialIds() {
  let next = 999;
  return {
    mint: vi.fn((count?: number) => Promise.resolve(Array.from({ length: count ?? 1 }, () => String((next += 1))))),
  };
}

const IDS = ['11', '12', '13', '14', '15'];

describe('publishSkuSnapshots', () => {
  it('pages through the catalog until a short page, minting each page in one call', async () => {
    const { pages, appended, productIdsAfter } = catalogOf(IDS);
    const ids = sequentialIds();

    await expect(publishSkuSnapshots(pages, ids, { pageSize: 2 })).resolves.toBe(5);

    expect(appended).toEqual([
      { productIds: ['11', '12'], outboxIds: ['1000', '1001'] },
      { productIds: ['13', '14'], outboxIds: ['1002', '1003'] },
      { productIds: ['15'], outboxIds: ['1004'] },
    ]);
    expect(ids.mint.mock.calls).toEqual([[2], [2], [1]]);
    expect(productIdsAfter.mock.calls).toEqual([
      [null, 2],
      ['12', 2],
      ['14', 2],
    ]);
  });

  it('stops at an empty page without minting for it', async () => {
    const { pages, appended } = catalogOf(IDS.slice(0, 4));
    const ids = sequentialIds();

    await expect(publishSkuSnapshots(pages, ids, { pageSize: 2 })).resolves.toBe(4);

    expect(appended).toHaveLength(2);
    expect(ids.mint).toHaveBeenCalledTimes(2);
  });

  it('publishes nothing for an empty catalog', async () => {
    const { pages, appended } = catalogOf([]);
    const ids = sequentialIds();

    await expect(publishSkuSnapshots(pages, ids)).resolves.toBe(0);

    expect(appended).toEqual([]);
    expect(ids.mint).not.toHaveBeenCalled();
  });

  it('stops before the next page once aborted, keeping the pages already appended', async () => {
    const interrupt = new AbortController();
    const reason = new Error('interrupted by SIGINT');
    const { pages, appended } = catalogOf(IDS, () => interrupt.abort(reason));

    await expect(publishSkuSnapshots(pages, sequentialIds(), { pageSize: 2, signal: interrupt.signal })).rejects.toBe(
      reason,
    );

    expect(appended.map(({ productIds }) => productIds)).toEqual([['11', '12']]);
  });

  it('appends nothing for a page the id service under-delivered', async () => {
    const { pages, appended } = catalogOf(IDS);
    const ids = { mint: vi.fn(() => Promise.resolve(['1000'])) };

    await expect(publishSkuSnapshots(pages, ids, { pageSize: 2 })).rejects.toThrow(/2 ids, got 1/);

    expect(appended).toEqual([]);
  });

  it('refuses a page size below 1', async () => {
    const { pages } = catalogOf(IDS);

    await expect(publishSkuSnapshots(pages, sequentialIds(), { pageSize: 0 })).rejects.toThrow(/page size/);
  });
});
