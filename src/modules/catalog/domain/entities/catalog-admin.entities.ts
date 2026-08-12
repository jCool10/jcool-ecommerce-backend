import type { ProductStatus } from './product.entity';

/**
 * Flat domain read-models for the admin write paths — each mirrors one persisted
 * row after a create/update/archive (distinct from the rich `Product` read
 * aggregate). Pure. Soft-delete is `archivedAt` on Category/Sku; Product uses
 * `status = 'ARCHIVED'`, so it carries no archivedAt.
 */

export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProductStatus;
  categoryId: string;
  createdAt: Date;
}

export interface Sku {
  id: string;
  sku: string;
  name: string;
  productId: string;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface Price {
  variantId: string;
  currency: string;
  amountMinor: number;
}
