import type { Product } from '../../domain/entities';
import type { SkuView } from '../public/catalog-sku-query.port';

// Read-side port — application must not import drizzle-orm/schema.
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
  findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult>;

  findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null>;

  /**
   * Returns the variant regardless of product status, so a consumer (Cart) can still show an item
   * whose product was archived after it was added; `isActive` reflects the current status.
   */
  findSkuView(skuId: string): Promise<SkuView | null>;

  /** An id with no variant is absent from the result. */
  findManySkuViews(skuIds: string[]): Promise<SkuView[]>;
}
