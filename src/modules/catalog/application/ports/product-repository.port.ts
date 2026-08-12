import type { Product } from '../../domain/entities/product.entity';

// Read-side port; the Drizzle adapter implements it in infrastructure/. This
// boundary is the swap point for a cache or search index later. Application must
// not import drizzle-orm/schema.
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
}
