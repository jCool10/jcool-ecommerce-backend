import type { AdminProduct, Category, Price, ProductImage, ProductStatus, Sku } from '../../domain/entities';

// Write-side port for the admin paths, separate from the read-only ProductRepositoryPort
// (CQRS-lite); the service owns 404/409 decisions, the adapter owns the atomic mutation (23505 → 409).
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
  // ----- Category -----
  findCategoryById(id: string): Promise<Category | null>;
  createCategory(data: CreateCategoryData): Promise<Category>;
  /** Patch the row; null if no category has that id. Empty patch = no-op fetch. */
  updateCategory(id: string, data: UpdateCategoryData): Promise<Category | null>;
  /** Idempotent soft-delete (keeps the first archivedAt); null if id unknown. */
  archiveCategory(id: string): Promise<Category | null>;
  /** Count non-archived (DRAFT or ACTIVE) products still under the category. */
  countActiveProductsInCategory(categoryId: string): Promise<number>;

  // ----- Product -----
  findProductById(id: string): Promise<AdminProduct | null>;
  createProduct(data: CreateProductData): Promise<AdminProduct>;
  updateProduct(id: string, data: UpdateProductData): Promise<AdminProduct | null>;
  /** Soft-delete via status='ARCHIVED'; null if id unknown. */
  archiveProduct(id: string): Promise<AdminProduct | null>;

  // ----- Sku (product variant) -----
  findSkuById(id: string): Promise<Sku | null>;
  createSku(productId: string, data: CreateSkuData): Promise<Sku>;
  updateSku(id: string, data: UpdateSkuData): Promise<Sku | null>;
  archiveSku(id: string): Promise<Sku | null>;

  // ----- Product images -----
  /**
   * Image rows in display order. No `tx` parameter anywhere here: the adapter opens its own
   * transaction and claims the asset from Media inside it, so the link row and the asset's status
   * commit together or not at all.
   */
  listImages(productId: string): Promise<ProductImage[]>;
  /** Link an asset to the product and claim it in Media. Duplicate (product, asset) → 409. */
  attachImage(productId: string, data: AttachImageData): Promise<ProductImage>;
  /** Unlink and release the asset back to Media; null if no such image on that product. */
  detachImage(productId: string, imageId: string): Promise<ProductImage | null>;
  /** Rewrite positions from the given order. Null when `imageIds` is not exactly the product's set. */
  reorderImages(productId: string, imageIds: string[]): Promise<ProductImage[] | null>;

  // ----- Price -----
  /** Upsert the (variant, currency) price — set or replace the current amount. */
  setPrice(variantId: string, data: SetPriceData): Promise<Price>;
}
