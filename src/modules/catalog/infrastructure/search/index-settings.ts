// Index identity + settings for the derived products index, applied idempotently by the adapter's
// ensureIndex. Kept engine-agnostic (plain arrays, no SDK type) so the adapter stays the only file
// bound to the search engine.
export const PRODUCTS_INDEX_UID = 'products';

// Upsert key: a reindex re-adds the same id, so re-runs converge instead of duplicating.
export const PRODUCTS_INDEX_PRIMARY_KEY = 'id';

// How far limit/offset paging can reach. The engine caps this to bound the cost of a deep page, and
// pins it here rather than relying on its default so the adapter can report a total the caller can
// actually page through instead of one that runs out partway.
export const SEARCH_MAX_TOTAL_HITS = 1000;

interface IndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  pagination: { maxTotalHits: number };
}

// Attribute order in searchableAttributes IS the relevance priority: a match in `name` outranks one
// in `description`, which the engine's default ranking rules (words → typo → proximity →
// attributeRank → sort → wordPosition → exactness) honour with no extra config — the typo-tolerant
// relevance `ilike` cannot give. Ranking rules are left at those defaults (deliberately not set
// here, so an engine upgrade's tuning carries over); custom boosts stay a seam.
export const PRODUCTS_INDEX_SETTINGS: IndexSettings = {
  searchableAttributes: ['name', 'skus', 'categoryName', 'description'],
  filterableAttributes: ['categorySlug', 'status', 'currency'],
  sortableAttributes: ['createdAtEpoch', 'minPriceMinor'],
  pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
};
