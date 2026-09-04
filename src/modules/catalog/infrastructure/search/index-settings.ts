// Index identity + settings for the derived products index, applied idempotently by the adapter's
// ensureIndex. Kept engine-agnostic (plain arrays, no SDK type) so the adapter stays the only file
// bound to the search engine.
export const PRODUCTS_INDEX_UID = 'products';

// Upsert key: a reindex re-adds the same id, so re-runs converge instead of duplicating.
export const PRODUCTS_INDEX_PRIMARY_KEY = 'id';

interface IndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
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
};
