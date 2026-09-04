import { toSearchableProduct } from '../../application/catalog-search.mapper';
import type { CatalogSearchPort, ProductRepositoryPort } from '../../application/ports';

// Bounded read so rebuilding a large catalog never loads the whole table into memory.
const PAGE_SIZE = 500;

export interface ReindexOptions {
  /** Clear the index before loading, at the cost of a window where search matches nothing. */
  reset?: boolean;
}

/**
 * Rebuild the derived index from Postgres, the single source of truth — which is why a corrupted or
 * lost index is never a data-loss event. Upserting by id makes a re-run idempotent, but it only ever
 * adds: a document whose product has since left the ACTIVE set survives until a `reset` run drops it.
 *
 * Takes its collaborators as arguments so the CLI can hand it the non-caching repository (a rebuild
 * must never be served a stale snapshot) while a test hands it the wired one.
 */
export async function reindexAll(
  repo: ProductRepositoryPort,
  search: CatalogSearchPort,
  options: ReindexOptions = {},
): Promise<number> {
  await search.ensureIndex();
  if (options.reset) await search.resetIndex();

  let page = 1;
  let indexed = 0;
  for (;;) {
    const { items, total } = await repo.findManyActive({ page, pageSize: PAGE_SIZE });
    if (items.length === 0) break;
    await search.bulkIndex(items.map(toSearchableProduct));
    indexed += items.length;
    if (indexed >= total) break;
    page += 1;
  }
  return indexed;
}
