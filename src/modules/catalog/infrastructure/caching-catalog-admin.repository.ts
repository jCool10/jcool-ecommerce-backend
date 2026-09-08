import { Injectable } from '@nestjs/common';
import { CacheService } from '@shared/cache';
import type { AdminProduct, Category, Price, ProductImage, Sku } from '../domain/entities';
import type {
  AttachImageData,
  CatalogAdminRepositoryPort,
  CreateCategoryData,
  CreateProductData,
  CreateSkuData,
  SetPriceData,
  UpdateCategoryData,
  UpdateProductData,
  UpdateSkuData,
} from '../application/ports';
import { CATALOG_CACHE_VERSION_KEY } from './catalog-cache.keys';
import { DrizzleCatalogAdminRepository } from './drizzle-catalog-admin.repository';

/**
 * Invalidation lives here rather than in `CatalogAdminService` so the application layer keeps no
 * cache knowledge, and the generation bump runs after the adapter's transaction has committed — a
 * bump for a write that then rolled back only costs a needless miss, but a bump before commit could
 * refill the cache from the pre-commit state and stay stale until the TTL.
 */
@Injectable()
export class CachingCatalogAdminRepository implements CatalogAdminRepositoryPort {
  constructor(
    private readonly source: DrizzleCatalogAdminRepository,
    private readonly cache: CacheService,
  ) {}

  findCategoryById(id: string): Promise<Category | null> {
    return this.source.findCategoryById(id);
  }

  createCategory(data: CreateCategoryData): Promise<Category> {
    return this.invalidatingWrite(() => this.source.createCategory(data));
  }

  updateCategory(id: string, data: UpdateCategoryData): Promise<Category | null> {
    return this.invalidatingWrite(() => this.source.updateCategory(id, data));
  }

  archiveCategory(id: string): Promise<Category | null> {
    return this.invalidatingWrite(() => this.source.archiveCategory(id));
  }

  countActiveProductsInCategory(categoryId: string): Promise<number> {
    return this.source.countActiveProductsInCategory(categoryId);
  }

  findProductById(id: string): Promise<AdminProduct | null> {
    return this.source.findProductById(id);
  }

  createProduct(data: CreateProductData): Promise<AdminProduct> {
    return this.invalidatingWrite(() => this.source.createProduct(data));
  }

  updateProduct(id: string, data: UpdateProductData): Promise<AdminProduct | null> {
    return this.invalidatingWrite(() => this.source.updateProduct(id, data));
  }

  archiveProduct(id: string): Promise<AdminProduct | null> {
    return this.invalidatingWrite(() => this.source.archiveProduct(id));
  }

  findSkuById(id: string): Promise<Sku | null> {
    return this.source.findSkuById(id);
  }

  createSku(productId: string, data: CreateSkuData): Promise<Sku> {
    return this.invalidatingWrite(() => this.source.createSku(productId, data));
  }

  updateSku(id: string, data: UpdateSkuData): Promise<Sku | null> {
    return this.invalidatingWrite(() => this.source.updateSku(id, data));
  }

  archiveSku(id: string): Promise<Sku | null> {
    return this.invalidatingWrite(() => this.source.archiveSku(id));
  }

  listImages(productId: string): Promise<ProductImage[]> {
    return this.source.listImages(productId);
  }

  attachImage(productId: string, data: AttachImageData): Promise<ProductImage> {
    return this.invalidatingWrite(() => this.source.attachImage(productId, data));
  }

  detachImage(productId: string, imageId: string): Promise<ProductImage | null> {
    return this.invalidatingWrite(() => this.source.detachImage(productId, imageId));
  }

  reorderImages(productId: string, imageIds: string[]): Promise<ProductImage[] | null> {
    return this.invalidatingWrite(() => this.source.reorderImages(productId, imageIds));
  }

  setPrice(variantId: string, data: SetPriceData): Promise<Price> {
    return this.invalidatingWrite(() => this.source.setPrice(variantId, data));
  }

  // A null result means the id was unknown and nothing changed, so the cached generation is still
  // accurate — a 404 must not cold-start the whole catalog cache.
  private async invalidatingWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = await write();
    if (result !== null) {
      await this.cache.bumpCounter(CATALOG_CACHE_VERSION_KEY);
    }
    return result;
  }
}
