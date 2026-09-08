// Kept engine-agnostic (plain arrays, no SDK type) so the adapter stays the only file bound to the
// search engine.
export const PRODUCTS_INDEX_UID = 'products';

// Upsert key: a reindex re-adds the same id, so re-runs converge instead of duplicating.
export const PRODUCTS_INDEX_PRIMARY_KEY = 'id';

// How far limit/offset paging can reach. Pinned here rather than left to the engine default so the
// adapter can report a total the caller can actually page through instead of one that runs out.
export const SEARCH_MAX_TOTAL_HITS = 1000;

interface IndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  pagination: { maxTotalHits: number };
}

// Attribute order in searchableAttributes IS the relevance priority: a match in `name` outranks one
// in `description`, honoured by the engine's default ranking rules (attributeRank is one of them).
// Rules are deliberately left unset so an engine upgrade's tuning carries over.
export const PRODUCTS_INDEX_SETTINGS: IndexSettings = {
  searchableAttributes: ['name', 'skus', 'categoryName', 'description'],
  filterableAttributes: ['categorySlug', 'status', 'currency'],
  sortableAttributes: ['createdAtEpoch', 'minPriceMinor'],
  pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
};
