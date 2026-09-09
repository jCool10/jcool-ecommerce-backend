import { toSearchableProduct } from '../../application/catalog-search.mapper';
import type { CatalogSearchPort, ProductRepositoryPort } from '../../application/ports';

const PAGE_SIZE = 500;

export interface ReindexOptions {
  /** Costs a window in which search matches nothing. */
  reset?: boolean;
}

/**
 * Upserting by id makes a re-run idempotent, but it only ever adds: a document whose product has
 * since left the ACTIVE set survives until a `reset` run drops it.
 */
export async function reindexAll(
  repo: ProductRepositoryPort,
  search: CatalogSearchPort,
  options: ReindexOptions = {},
): Promise<number> {
  await search.ensureIndex();
  if (options.reset) await search.resetIndex();

  // Keyset, not offset: each page is its own snapshot, so a product archived behind the cursor
  // mid-run would shift every later row up one offset and one of them would never be read. The
  // cursor is the id alone — carrying a timestamp costs precision the seek needs to advance.
  let cursor: string | null = null;
  let indexed = 0;
  for (;;) {
    const items = await repo.findActiveAfter(cursor, PAGE_SIZE);
    if (items.length === 0) break;
    await search.bulkIndex(items.map(toSearchableProduct));
    indexed += items.length;
    cursor = items[items.length - 1].id;
    if (items.length < PAGE_SIZE) break;
  }
  return indexed;
}
