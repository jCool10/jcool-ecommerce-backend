import { setTimeout as delay } from 'node:timers/promises';
import { toSearchDocumentWrite } from '../../application/catalog-search.mapper';
import type { CatalogSearchPort, ProductSearchStatePort } from '../../application/ports';

const PAGE_SIZE = 500;
// Long enough for a search already routed to a retired index to finish.
const GRACE_MS = 30_000;

export interface RebuildOptions {
  pageSize?: number;
  graceMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  // Checked between pages; once aborted, the run drops its index instead of leaving the lock behind.
  signal?: AbortSignal;
}

export interface RebuildResult {
  documents: number;
  tombstones: number;
  retired: string[];
}

/**
 * Fills a fresh index from Postgres, swaps search onto it, and drops the retired indices after a grace.
 * Live writes reach the new index for the whole build, so a change made meanwhile is kept, and no
 * catch-up pass is needed. Every product goes in at its row version, a tombstone for each one outside
 * the public projection, so a late stale write cannot bring an archived product back after the swap.
 */
export async function rebuildIndex(
  states: ProductSearchStatePort,
  search: CatalogSearchPort,
  { pageSize = PAGE_SIZE, graceMs = GRACE_MS, sleep = delay, signal }: RebuildOptions = {},
): Promise<RebuildResult> {
  const rebuild = await search.beginRebuild();

  let counts: Omit<RebuildResult, 'retired'>;
  let retired: string[];
  try {
    counts = await fill(states, search, pageSize, signal);
    retired = await search.promoteRebuild(rebuild);
  } catch (error) {
    await search.abortRebuild(rebuild).catch((abortError: unknown) => {
      throw new AggregateError([error, abortError], 'the rebuild failed, and so did its abort');
    });
    throw error;
  }

  await sleep(graceMs);
  await search.dropRetired(retired);
  return { ...counts, retired };
}

async function fill(
  states: ProductSearchStatePort,
  search: CatalogSearchPort,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<Omit<RebuildResult, 'retired'>> {
  const counts = { documents: 0, tombstones: 0 };
  let cursor: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const page = await states.findAfter(cursor, pageSize);
    if (page.length === 0) break;
    const changes = page.map(toSearchDocumentWrite);
    await search.writeRebuild(changes);
    for (const change of changes) {
      if (change.doc) counts.documents += 1;
      else counts.tombstones += 1;
    }
    cursor = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }
  return counts;
}
