import type { Product } from '../../domain/entities';

// Bound straight to the Drizzle adapter: a cached read could hand the indexer a state older than
// the version it is about to write.
export const PRODUCT_SEARCH_STATE = Symbol('PRODUCT_SEARCH_STATE');

export interface ProductSearchState {
  id: string;
  version: number;
  /** The public projection; null when the product is not publicly visible. */
  product: Product | null;
}

/** Version and projection come from one snapshot, so they always describe the same row state. */
export interface ProductSearchStatePort {
  /** Unknown ids are absent from the result. */
  findByIds(ids: string[]): Promise<ProductSearchState[]>;

  /** Keyset page over every product, whatever its status, ascending by id. */
  findAfter(afterId: string | null, limit: number): Promise<ProductSearchState[]>;
}
