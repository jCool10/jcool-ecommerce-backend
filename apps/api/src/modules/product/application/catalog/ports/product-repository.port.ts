import type { Product } from '../../../domain/catalog/entities';

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
}
