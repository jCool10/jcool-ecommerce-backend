import type { ProductStatus } from './product.entity';

// Flat read-models for the admin write paths, each mirroring one persisted row.
// Soft-delete is `archivedAt` on Category/Sku; Product uses `status = 'ARCHIVED'`.

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

/** `assetId` belongs to Media; this row is only the link and its order. */
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
