import type { AdminProduct, Category, Price, ProductImage, ProductStatus, Sku } from '../../domain/entities';

// The service owns 404/409 decisions, the adapter owns the atomic mutation (23505 → 409).
export const CATALOG_ADMIN_REPOSITORY = Symbol('CATALOG_ADMIN_REPOSITORY');

export interface CreateCategoryData {
  name: string;
  slug: string;
  parentId?: string | null;
}
export interface UpdateCategoryData {
  name?: string;
  slug?: string;
  parentId?: string | null;
}

export interface CreateProductData {
  name: string;
  slug: string;
  description?: string | null;
  status?: ProductStatus;
  categoryId: string;
}
export interface UpdateProductData {
  name?: string;
  slug?: string;
  description?: string | null;
  status?: ProductStatus;
  categoryId?: string;
}

export interface CreateSkuData {
  sku: string;
  name: string;
}
export interface UpdateSkuData {
  sku?: string;
  name?: string;
}

export interface SetPriceData {
  currency: string;
  amountMinor: number;
}

export interface AttachImageData {
  assetId: string;
  position?: number;
  alt?: string | null;
}

export interface CatalogAdminRepositoryPort {
  findCategoryById(id: string): Promise<Category | null>;
  createCategory(data: CreateCategoryData): Promise<Category>;
  /** Empty patch = no-op fetch. */
  updateCategory(id: string, data: UpdateCategoryData): Promise<Category | null>;
  /** Idempotent soft-delete — keeps the first archivedAt. */
  archiveCategory(id: string): Promise<Category | null>;
  /** "Active" here means non-archived: DRAFT or ACTIVE. */
  countActiveProductsInCategory(categoryId: string): Promise<number>;

  findProductById(id: string): Promise<AdminProduct | null>;
  createProduct(data: CreateProductData): Promise<AdminProduct>;
  updateProduct(id: string, data: UpdateProductData): Promise<AdminProduct | null>;
  archiveProduct(id: string): Promise<AdminProduct | null>;

  findSkuById(id: string): Promise<Sku | null>;
  createSku(productId: string, data: CreateSkuData): Promise<Sku>;
  updateSku(id: string, data: UpdateSkuData): Promise<Sku | null>;
  archiveSku(id: string): Promise<Sku | null>;

  /**
   * Image rows in display order. No `tx` parameter anywhere here: the adapter opens its own
   * transaction and claims the asset from Media inside it, so the link row and the asset's status
   * commit together or not at all.
   */
  listImages(productId: string): Promise<ProductImage[]>;
  /** Also claims the asset in Media. Duplicate (product, asset) → 409. */
  attachImage(productId: string, data: AttachImageData): Promise<ProductImage>;
  /** Also releases the asset back to Media; null if no such image on that product. */
  detachImage(productId: string, imageId: string): Promise<ProductImage | null>;
  /** Null when `imageIds` is not exactly the product's set. */
  reorderImages(productId: string, imageIds: string[]): Promise<ProductImage[] | null>;

  /** Upsert keyed by (variant, currency). */
  setPrice(variantId: string, data: SetPriceData): Promise<Price>;
}
