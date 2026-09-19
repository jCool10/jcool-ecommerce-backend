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

export interface CatalogSearchPort {
  // Idempotent, so a reindex or a restart may call it freely.
  ensureIndex(): Promise<void>;
  // Drops every document but keeps the index and its settings, so a full reindex cannot leave behind
  // docs whose product has since left the indexed set.
  resetIndex(): Promise<void>;
  bulkIndex(docs: SearchableProduct[]): Promise<void>;
  indexProduct(doc: SearchableProduct): Promise<void>;
  deleteProduct(id: string): Promise<void>;
  // Best-effort read: an engine failure resolves to an empty result rather than throwing, because
  // search is an optional path over Postgres. Writes, by contrast, surface their error so the caller
  // decides whether a lagging index fails its mutation.
  search(criteria: SearchCriteria): Promise<SearchResult>;
}
