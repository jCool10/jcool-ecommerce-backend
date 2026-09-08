import type { ProductStatus } from './product.entity';

/** Flat domain read-models for the admin write paths — each mirrors one persisted row after a create/update/archive (distinct from the rich `Product` read aggregate); soft-delete is `archivedAt` on Category/Sku, while Product uses `status = 'ARCHIVED'`. */

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

/** One image slot on a product. `assetId` belongs to Media; this row is only the link and its order. */
export interface ProductImage {
  id: string;
  productId: string;
  assetId: string;
  position: number;
  alt: string | null;
  createdAt: Date;
}

export interface Price {
  variantId: string;
  currency: string;
  amountMinor: number;
}
