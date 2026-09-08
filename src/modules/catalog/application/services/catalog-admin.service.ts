import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MediaAssetUnavailableError } from '@modules/media/application/public/media-facade.port';
import { Slug } from '../../domain/slug.vo';
import type { AdminProduct, Category, Price, ProductImage, Sku } from '../../domain/entities';
import { toSearchableProduct } from '../catalog-search.mapper';
import {
  type AttachImageData,
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  PRODUCT_REPOSITORY,
  type CatalogAdminRepositoryPort,
  type CatalogSearchPort,
  type CreateCategoryData,
  type CreateProductData,
  type CreateSkuData,
  type ProductRepositoryPort,
  type SetPriceData,
  type UpdateCategoryData,
  type UpdateProductData,
  type UpdateSkuData,
} from '../ports';

const DEFAULT_CURRENCY = 'VND';

/** Catalog admin write orchestration — one service (not ~10 near-identical use-case classes) since the operations share the same ref-existence checks (404) and archive guard (409); it owns those business decisions, the adapter owns the atomic writes. See docs/engineering-notes.md (Catalog — Admin write path). */
@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger(CatalogAdminService.name);

  constructor(
    @Inject(CATALOG_ADMIN_REPOSITORY)
    private readonly repo: CatalogAdminRepositoryPort,
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
    @Inject(CATALOG_SEARCH)
    private readonly search: CatalogSearchPort,
  ) {}

  // ----- Category -----

  createCategory(data: CreateCategoryData): Promise<Category> {
    // Slug shape normalized/validated in the domain (Slug VO); uniqueness is
    // enforced by the DB and the adapter maps 23505 -> 409.
    return this.repo.createCategory({ ...data, slug: Slug.of(data.slug).value });
  }

  async updateCategory(id: string, data: UpdateCategoryData): Promise<Category> {
    const patch = data.slug !== undefined ? { ...data, slug: Slug.of(data.slug).value } : data;
    const updated = await this.repo.updateCategory(id, patch);
    if (!updated) {
      throw new NotFoundException(`Category not found: ${id}`);
    }
    // A rename lands in the category fields denormalized into every product document underneath —
    // an unbounded fan-out this request deliberately does not run; `search:reindex` converges them.
    if (data.name !== undefined || data.slug !== undefined) {
      this.logger.warn(`category ${id} renamed; its product search documents stay stale until a reindex`);
    }
    return updated;
  }

  /** Soft-delete a category, refusing (409) while it still has live products. */
  async archiveCategory(id: string): Promise<Category> {
    const activeProducts = await this.repo.countActiveProductsInCategory(id);
    if (activeProducts > 0) {
      throw new ConflictException('Category still has active products');
    }
    const archived = await this.repo.archiveCategory(id);
    if (!archived) {
      throw new NotFoundException(`Category not found: ${id}`);
    }
    // No search sync: the guard above already proved no live product references this category, so
    // nothing indexed can be affected.
    return archived;
  }

  // ----- Product -----

  async createProduct(data: CreateProductData): Promise<AdminProduct> {
    await this.assertCategoryUsable(data.categoryId);
    const created = await this.repo.createProduct({ ...data, slug: Slug.of(data.slug).value });
    await this.syncSearchDocument(created.id);
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
    await this.syncSearchDocument(updated.id);
    return updated;
  }

  async archiveProduct(id: string): Promise<AdminProduct> {
    const archived = await this.repo.archiveProduct(id);
    if (!archived) {
      throw new NotFoundException(`Product not found: ${id}`);
    }
    await this.syncSearchDocument(archived.id);
    return archived;
  }

  // ----- Sku (product variant) -----

  async createSku(productId: string, data: CreateSkuData): Promise<Sku> {
    await this.assertProductExists(productId);
    const created = await this.repo.createSku(productId, data);
    await this.syncSearchDocument(created.productId);
    return created;
  }

  async updateSku(id: string, data: UpdateSkuData): Promise<Sku> {
    const updated = await this.repo.updateSku(id, data);
    if (!updated) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    await this.syncSearchDocument(updated.productId);
    return updated;
  }

  async archiveSku(id: string): Promise<Sku> {
    const archived = await this.repo.archiveSku(id);
    if (!archived) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    await this.syncSearchDocument(archived.productId);
    return archived;
  }

  // ----- Product images -----

  /**
   * Images are not indexed, so none of these syncs the search document: a search hit renders from
   * the document's own fields, and adding an image to one would make every attach a reindex.
   */
  async listProductImages(productId: string): Promise<ProductImage[]> {
    await this.assertProductExists(productId);
    return this.repo.listImages(productId);
  }

  async attachProductImage(productId: string, data: AttachImageData): Promise<ProductImage> {
    await this.assertProductExists(productId);
    try {
      return await this.repo.attachImage(productId, data);
    } catch (error) {
      // The asset is missing, still uploading, or already attached elsewhere — a client mistake
      // about state, not about this request's shape.
      if (error instanceof MediaAssetUnavailableError) {
        throw new ConflictException(`Image asset is not available to attach: ${error.assetId}`);
      }
      throw error;
    }
  }

  async detachProductImage(productId: string, imageId: string): Promise<ProductImage> {
    const detached = await this.repo.detachImage(productId, imageId);
    if (!detached) {
      throw new NotFoundException(`Image not found on product ${productId}: ${imageId}`);
    }
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

  // ----- Price -----

  async setPrice(skuId: string, data: { amountMinor: number; currency?: string }): Promise<Price> {
    const sku = await this.repo.findSkuById(skuId);
    if (!sku) {
      throw new NotFoundException(`SKU not found: ${skuId}`);
    }
    const payload: SetPriceData = { currency: data.currency ?? DEFAULT_CURRENCY, amountMinor: data.amountMinor };
    const price = await this.repo.setPrice(skuId, payload);
    // A variant's price is denormalized into its parent's document, so the parent is what re-indexes.
    await this.syncSearchDocument(sku.productId);
    return price;
  }

  // ----- helpers -----

  // A product may only reference a live category; this can't catch a status-only PATCH
  // or archive/publish race, so the public read filters archived categories independently.
  private async assertProductExists(productId: string): Promise<void> {
    if (!(await this.repo.findProductById(productId))) {
      throw new NotFoundException(`Product not found: ${productId}`);
    }
  }

  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.repo.findCategoryById(categoryId);
    if (!category || category.archivedAt !== null) {
      throw new NotFoundException(`Category not found: ${categoryId}`);
    }
  }

  /**
   * Re-derive one product's search document, after its write has committed. Re-reading the public
   * ACTIVE projection is what decides index-vs-delete, so a draft, an archived product and one whose
   * category was archived all leave the index without a second copy of that visibility rule.
   *
   * Best-effort on purpose: the index is a replica of Postgres, so a search engine that is down must
   * cost freshness, never the admin write. That makes this a dual-write — a crash between the commit
   * and this call leaves the index behind, exactly as a failure here does — and `search:reindex` is
   * the backstop that converges both. Closing the gap properly means emitting the change to the
   * transactional outbox inside the mutation's transaction, which the admin write port does not
   * currently expose one for.
   */
  private async syncSearchDocument(productId: string): Promise<void> {
    try {
      const product = await this.products.findActiveByIdOrSlug(productId);
      // The lookup also matches on slug, so a product whose slug equals this id would answer for it
      // once the real row stops being ACTIVE; only an id match is this product.
      if (product?.id === productId) {
        await this.search.indexProduct(toSearchableProduct(product));
      } else {
        await this.search.deleteProduct(productId);
      }
    } catch (error) {
      this.logger.warn(
        `search index sync failed for product ${productId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
