import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { MediaAssetUnavailableError } from '@modules/media/application/public/media-facade.port';
import { Slug } from '../../domain/slug.vo';
import type { AdminProduct, Category, Price, ProductImage, Sku } from '../../domain/entities';
import {
  type AttachImageData,
  CATALOG_ADMIN_REPOSITORY,
  type CatalogAdminRepositoryPort,
  type CreateCategoryData,
  type CreateProductData,
  type CreateSkuData,
  type SetPriceData,
  type UpdateCategoryData,
  type UpdateProductData,
  type UpdateSkuData,
} from '../ports';

const DEFAULT_CURRENCY = 'VND';

const LOG_CONTEXT = 'CatalogAdminService';

/**
 * One service rather than ~10 near-identical use-case classes: the operations share the same
 * ref-existence checks (404) and archive guard (409).
 */
@Injectable()
export class CatalogAdminService {
  constructor(
    @Inject(CATALOG_ADMIN_REPOSITORY)
    private readonly repo: CatalogAdminRepositoryPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async createCategory(data: CreateCategoryData): Promise<Category> {
    // Uniqueness is enforced by the DB; the adapter maps 23505 -> 409.
    const created = await this.repo.createCategory({ ...data, slug: Slug.of(data.slug).value });
    this.logger.info({ categoryId: created.id }, 'category created');
    return created;
  }

  async updateCategory(id: string, data: UpdateCategoryData): Promise<Category> {
    const patch = data.slug !== undefined ? { ...data, slug: Slug.of(data.slug).value } : data;
    const updated = await this.repo.updateCategory(id, patch);
    if (!updated) {
      throw new NotFoundException(`Category not found: ${id}`);
    }
    this.logger.info({ categoryId: id }, 'category updated');
    return updated;
  }

  async archiveCategory(id: string): Promise<Category> {
    const { category, blocked } = await this.repo.archiveCategoryIfEmpty(id);
    if (blocked) {
      throw new ConflictException('Category still has active products');
    }
    if (!category) {
      throw new NotFoundException(`Category not found: ${id}`);
    }
    this.logger.info({ categoryId: id }, 'category archived');
    // The archive's row lock serializes against the product writes that name this category (a
    // create, and a categoryId move), so none of those can commit behind the count. A status-only
    // PATCH names no category and takes no lock, so a product can still be activated under an
    // archived category; the public read's `categories.archived_at IS NULL` filter is what keeps
    // that product out of the results.
    return category;
  }

  async createProduct(data: CreateProductData): Promise<AdminProduct> {
    await this.assertCategoryUsable(data.categoryId);
    const created = await this.repo.createProduct({ ...data, slug: Slug.of(data.slug).value });
    this.logger.info({ productId: created.id, categoryId: created.categoryId }, 'product created');
    return created;
  }

  async updateProduct(id: string, data: UpdateProductData): Promise<AdminProduct> {
    if (data.categoryId !== undefined) {
      await this.assertCategoryUsable(data.categoryId);
    }
    const patch = data.slug !== undefined ? { ...data, slug: Slug.of(data.slug).value } : data;
    const updated = await this.repo.updateProduct(id, patch);
    if (!updated) {
      throw new NotFoundException(`Product not found: ${id}`);
    }
    this.logger.info({ productId: id }, 'product updated');
    return updated;
  }

  async archiveProduct(id: string): Promise<AdminProduct> {
    const archived = await this.repo.archiveProduct(id);
    if (!archived) {
      throw new NotFoundException(`Product not found: ${id}`);
    }
    this.logger.info({ productId: id }, 'product archived');
    return archived;
  }

  async createSku(productId: string, data: CreateSkuData): Promise<Sku> {
    await this.assertProductExists(productId);
    const created = await this.repo.createSku(productId, data);
    this.logger.info({ skuId: created.id, productId }, 'sku created');
    return created;
  }

  async updateSku(id: string, data: UpdateSkuData): Promise<Sku> {
    const updated = await this.repo.updateSku(id, data);
    if (!updated) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    this.logger.info({ skuId: id, productId: updated.productId }, 'sku updated');
    return updated;
  }

  async archiveSku(id: string): Promise<Sku> {
    const archived = await this.repo.archiveSku(id);
    if (!archived) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    this.logger.info({ skuId: id, productId: archived.productId }, 'sku archived');
    return archived;
  }

  /**
   * Images are not in the search document, so none of these changes it: a search hit renders from
   * the document's own fields, and adding an image to one would make every attach a reindex.
   */
  async listProductImages(productId: string): Promise<ProductImage[]> {
    await this.assertProductExists(productId);
    return this.repo.listImages(productId);
  }

  async attachProductImage(productId: string, data: AttachImageData): Promise<ProductImage> {
    await this.assertProductExists(productId);
    try {
      const attached = await this.repo.attachImage(productId, data);
      this.logger.info({ productId, imageId: attached.id, assetId: data.assetId }, 'product image attached');
      return attached;
    } catch (error) {
      // Missing, still uploading, or already attached elsewhere — a state conflict, not a bad request.
      if (error instanceof MediaAssetUnavailableError) {
        throw new ConflictException(`Image asset is not available to attach: ${error.assetId}`, { cause: error });
      }
      throw error;
    }
  }

  async detachProductImage(productId: string, imageId: string): Promise<ProductImage> {
    const detached = await this.repo.detachImage(productId, imageId);
    if (!detached) {
      throw new NotFoundException(`Image not found on product ${productId}: ${imageId}`);
    }
    this.logger.info({ productId, imageId }, 'product image detached');
    return detached;
  }

  async reorderProductImages(productId: string, imageIds: string[]): Promise<ProductImage[]> {
    await this.assertProductExists(productId);
    const reordered = await this.repo.reorderImages(productId, imageIds);
    // A partial order would silently leave the omitted images wherever they were, so the whole set
    // is required and a mismatch is refused rather than half-applied.
    if (!reordered) {
      throw new ConflictException('Image order must list every image on the product exactly once');
    }
    return reordered;
  }

  async setPrice(skuId: string, data: { amountMinor: number; currency?: string }): Promise<Price> {
    const sku = await this.repo.findSkuById(skuId);
    if (!sku) {
      throw new NotFoundException(`SKU not found: ${skuId}`);
    }
    const payload: SetPriceData = { currency: data.currency ?? DEFAULT_CURRENCY, amountMinor: data.amountMinor };
    const price = await this.repo.setPrice(skuId, payload);
    this.logger.info({ skuId, amountMinor: price.amountMinor, currency: price.currency }, 'price set');
    return price;
  }

  private async assertProductExists(productId: string): Promise<void> {
    if (!(await this.repo.findProductById(productId))) {
      throw new NotFoundException(`Product not found: ${productId}`);
    }
  }

  // A cheap pre-check that answers 404 before any write is attempted; the adapter re-checks the
  // category under a row lock, which is what holds the rule against a concurrent archive. Neither
  // runs for a status-only PATCH, which names no category.
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.repo.findCategoryById(categoryId);
    if (!category || category.archivedAt !== null) {
      throw new NotFoundException(`Category not found: ${categoryId}`);
    }
  }
}
