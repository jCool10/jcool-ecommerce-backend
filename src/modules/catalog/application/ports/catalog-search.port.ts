// Read + write access to the derived search index. Kept engine-agnostic (no SDK type in any
// signature) so the application/domain never bind a concrete engine: only the infrastructure adapter
// knows the engine, and swapping it is a new adapter behind this token — nothing above the port moves.
export const CATALOG_SEARCH = Symbol('CATALOG_SEARCH');

// One denormalized product per search document. SKU codes and the price range are flattened in so a
// single query can match and rank on them without a join the engine cannot do.
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
  // Create the index and apply its settings; idempotent so a reindex or a restart may call it freely.
  ensureIndex(): Promise<void>;
  bulkIndex(docs: SearchableProduct[]): Promise<void>;
  indexProduct(doc: SearchableProduct): Promise<void>;
  deleteProduct(id: string): Promise<void>;
  // Best-effort read: an engine failure resolves to an empty result rather than throwing, because
  // search is an optional path over Postgres and must never fail the request wholesale. Writes, by
  // contrast, surface their error so the caller decides whether a lagging index fails its mutation.
  search(criteria: SearchCriteria): Promise<SearchResult>;
}
