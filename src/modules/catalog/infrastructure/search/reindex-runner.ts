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
