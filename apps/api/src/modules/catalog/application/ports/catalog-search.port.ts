// Engine-agnostic by design (no SDK type in any signature): only the infrastructure adapter knows the
// engine, so swapping it is a new adapter behind this token and nothing above the port moves.
export const CATALOG_SEARCH = Symbol('CATALOG_SEARCH');

// SKU codes and the price range are flattened in so a single query can match and rank on them
// without a join the engine cannot do.
export interface SearchableProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  categorySlug: string;
  categoryName: string;
  status: string;
  skus: string[];
  minPriceMinor: number | null;
  currency: string | null;
  // Epoch millis, not an ISO string: the engine sorts recency numerically.
  createdAtEpoch: number;
}

export interface SearchCriteria {
  q: string;
  page: number;
  pageSize: number;
  categorySlug?: string;
}

export interface SearchHit {
  id: string;
  name: string;
  slug: string;
  categorySlug: string;
  minPriceMinor: number | null;
  currency: string | null;
  // Matched substrings wrapped for display; absent when the engine returned no formatted copy.
  highlight?: { name?: string; description?: string };
}

export interface SearchResult {
  items: SearchHit[];
  total: number;
}

export interface SearchDocumentWrite {
  id: string;
  version: number;
  // null: the product left the public projection. Stored as a tombstone, never deleted.
  doc: SearchableProduct | null;
}

export class RebuildInProgressError extends Error {
  constructor() {
    super('a search index rebuild is already in progress');
    this.name = 'RebuildInProgressError';
  }
}

export interface CatalogSearchPort {
  // Idempotent, so a reindex or a restart may call it freely.
  ensureIndex(): Promise<void>;
  // Versioned. A write at or below the stored version is ignored, not an error. Reaches a rebuild in
  // progress too, so a change made during the build survives the swap.
  write(changes: SearchDocumentWrite[]): Promise<void>;
  // Best-effort read: an engine failure resolves to an empty result rather than throwing, because
  // search is an optional path over Postgres. Writes, by contrast, surface their error so the caller
  // can retry.
  search(criteria: SearchCriteria): Promise<SearchResult>;

  // Opens an empty index for a full rebuild and returns the handle the rest of that run acts on.
  // Rejects with RebuildInProgressError while another rebuild holds the lock.
  beginRebuild(): Promise<string>;
  // Versioned like write(), into the rebuild only.
  writeRebuild(changes: SearchDocumentWrite[]): Promise<void>;
  // Serves search from this rebuild's index and ends it in one atomic step; refused once its lock was
  // cleared. Returns the indices it retired, leftovers of earlier runs included.
  promoteRebuild(rebuild: string): Promise<string[]>;
  // Drops this rebuild, or with none given whichever holds the lock, as a crashed run leaves it.
  // Search never left the index it was on.
  abortRebuild(rebuild?: string): Promise<void>;
  // Deletes those of the given indices that nothing serves from any more.
  dropRetired(indices: string[]): Promise<void>;
}
