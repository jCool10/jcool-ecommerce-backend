import type { Product } from '../../domain/entities';
import type { SkuView } from '../public/catalog-sku-query.port';

// Read-side port; the Drizzle adapter implements it in infrastructure/ and this boundary is the
// swap point for a cache or search index later (application must not import drizzle-orm/schema).
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

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
  /** ACTIVE products only, paginated + optionally filtered. */
  findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult>;

  /** One ACTIVE product by id or slug, with variants + prices; null if none. */
  findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null>;

  /**
   * Live view of one SKU (product variant) by id, regardless of product status
   * so a consumer (Cart) can still show an item whose product was archived after
   * it was added. `isActive` reflects the current status; null if no such variant.
   */
  findSkuView(skuId: string): Promise<SkuView | null>;
}
