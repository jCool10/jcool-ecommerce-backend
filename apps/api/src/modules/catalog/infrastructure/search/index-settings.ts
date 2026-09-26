import type { estypes } from '@elastic/elasticsearch';

// Every read and write names the alias, never a physical index, so a rebuild can swap what is behind it.
export const PRODUCTS_ALIAS = 'products';

// Exists only while a rebuild runs: live writes reach the index being filled through it, and its
// presence is the lock that keeps a second rebuild out.
export const REBUILD_ALIAS = 'products_rebuilding';

// Physical indices are `products_v<n>`; bootstrap creates `products_v0`, a rebuild `products_v<epoch ms>`.
export const PRODUCTS_INDEX_PREFIX = 'products_v';

// How far from/size paging can reach. Pinned on the index so the adapter can report a total the
// caller can actually page through instead of one that runs out.
export const SEARCH_MAX_TOTAL_HITS = 1000;

const TEXT = { type: 'text', analyzer: 'folding' } as const;

export const PRODUCTS_INDEX_DEFINITION: {
  settings: estypes.IndicesIndexSettings;
  mappings: estypes.MappingTypeMapping;
} = {
  settings: {
    number_of_shards: 1,
    // A single node has nowhere to put a replica and would report yellow forever.
    number_of_replicas: 0,
    max_result_window: SEARCH_MAX_TOTAL_HITS,
    analysis: {
      // Folds Vietnamese diacritics and đ, keeping the original token so an exact query still ranks.
      filter: { folding: { type: 'asciifolding', preserve_original: true } },
      analyzer: { folding: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'folding'] } },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      name: TEXT,
      slug: { type: 'keyword' },
      description: TEXT,
      categorySlug: { type: 'keyword' },
      categoryName: TEXT,
      status: { type: 'keyword' },
      skus: TEXT,
      minPriceMinor: { type: 'long' },
      currency: { type: 'keyword' },
      createdAtEpoch: { type: 'date', format: 'epoch_millis' },
    },
  },
};
