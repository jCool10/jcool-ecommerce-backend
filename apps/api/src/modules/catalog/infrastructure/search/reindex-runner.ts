import { toSearchDocumentWrite } from '../../application/catalog-search.mapper';
import type { CatalogSearchPort, ProductSearchStatePort } from '../../application/ports';

const PAGE_SIZE = 500;

export interface ReindexCounts {
  documents: number;
  tombstones: number;
}

/**
 * Writes every product at its row version, a tombstone for each one outside the public projection,
 * so a re-run converges instead of needing a reset. It only repairs what bumped a version: a change
 * that did not keeps the engine refusing the same-version write.
 */
export async function reindexAll(states: ProductSearchStatePort, search: CatalogSearchPort): Promise<ReindexCounts> {
  await search.ensureIndex();

  const counts: ReindexCounts = { documents: 0, tombstones: 0 };
  let cursor: string | null = null;
  for (;;) {
    const page = await states.findAfter(cursor, PAGE_SIZE);
    if (page.length === 0) break;
    const changes = page.map(toSearchDocumentWrite);
    await search.write(changes);
    for (const change of changes) {
      if (change.doc) counts.documents += 1;
      else counts.tombstones += 1;
    }
    cursor = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }
  return counts;
}
