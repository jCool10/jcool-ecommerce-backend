import type { Product } from '../../domain/entities';
import type { SkuView } from '../public/catalog-sku-query.port';

// Read-side port — application must not import drizzle-orm/schema.
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

/**
 * The same port, bound to the uncached adapter. The search sync re-derives a document right after a
 * write, so it must read Postgres, never a generation-keyed snapshot whose invalidation may not
 * have landed.
 */
export const PRODUCT_SOURCE_REPOSITORY = Symbol('PRODUCT_SOURCE_REPOSITORY');

export interface FindManyActiveCriteria {
  page: number;
  pageSize: number;
  categorySlug?: string;
  q?: string;
}

export interface FindManyActiveResult {
  items: Product[];
  total: number;
}

export interface ProductRepositoryPort {
  findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult>;

  /**
   * Ascending keyset page of ACTIVE products for the reindex backstop, seeking past `afterId` — the
   * previous page's last row. Not LIMIT/OFFSET: that skips a row whenever a concurrent archive
   * shrinks the ordered set behind the current offset. The id alone is the whole cursor — it is the
   * primary key, so the sort needs no tiebreak, and uuidv7 puts a row written mid-scan ahead of it.
   */
  findActiveAfter(afterId: string | null, limit: number): Promise<Product[]>;

  findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null>;

  /**
   * Returns the variant regardless of product status, so a consumer (Cart) can still show an item
   * whose product was archived after it was added; `isActive` reflects the current status.
   */
  findSkuView(skuId: string): Promise<SkuView | null>;

  /** An id with no variant is absent from the result. */
  findManySkuViews(skuIds: string[]): Promise<SkuView[]>;
}
