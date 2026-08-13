import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Slug } from '../../domain/slug.vo';
import type { AdminProduct, Category, Price, Sku } from '../../domain/entities/catalog-admin.entities';
import {
  CATALOG_ADMIN_REPOSITORY,
  type CatalogAdminRepositoryPort,
  type CreateCategoryData,
  type CreateProductData,
  type CreateSkuData,
  type SetPriceData,
  type UpdateCategoryData,
  type UpdateProductData,
  type UpdateSkuData,
} from '../ports/catalog-admin-repository.port';

const DEFAULT_CURRENCY = 'VND';

/** Catalog admin write orchestration — one service (not ~10 near-identical use-case classes) since the operations share the same ref-existence checks (404) and archive guard (409); it owns those business decisions, the adapter owns the atomic writes. See docs/engineering-notes.md (Catalog — Admin write path). */
@Injectable()
export class CatalogAdminService {
  constructor(
    @Inject(CATALOG_ADMIN_REPOSITORY)
    private readonly repo: CatalogAdminRepositoryPort,
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
    return archived;
  }

  // ----- Product -----

  async createProduct(data: CreateProductData): Promise<AdminProduct> {
    await this.assertCategoryUsable(data.categoryId);
    return this.repo.createProduct({ ...data, slug: Slug.of(data.slug).value });
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
    return updated;
  }

  async archiveProduct(id: string): Promise<AdminProduct> {
    const archived = await this.repo.archiveProduct(id);
    if (!archived) {
      throw new NotFoundException(`Product not found: ${id}`);
    }
    return archived;
  }

  // ----- Sku (product variant) -----

  async createSku(productId: string, data: CreateSkuData): Promise<Sku> {
    const product = await this.repo.findProductById(productId);
    if (!product) {
      throw new NotFoundException(`Product not found: ${productId}`);
    }
    return this.repo.createSku(productId, data);
  }

  async updateSku(id: string, data: UpdateSkuData): Promise<Sku> {
    const updated = await this.repo.updateSku(id, data);
    if (!updated) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    return updated;
  }

  async archiveSku(id: string): Promise<Sku> {
    const archived = await this.repo.archiveSku(id);
    if (!archived) {
      throw new NotFoundException(`SKU not found: ${id}`);
    }
    return archived;
  }

  // ----- Price -----

  async setPrice(skuId: string, data: { amountMinor: number; currency?: string }): Promise<Price> {
    const sku = await this.repo.findSkuById(skuId);
    if (!sku) {
      throw new NotFoundException(`SKU not found: ${skuId}`);
    }
    const payload: SetPriceData = { currency: data.currency ?? DEFAULT_CURRENCY, amountMinor: data.amountMinor };
    return this.repo.setPrice(skuId, payload);
  }

  // ----- helpers -----

  // A product may only reference a live category; this can't catch a status-only PATCH
  // or archive/publish race, so the public read filters archived categories independently.
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.repo.findCategoryById(categoryId);
    if (!category || category.archivedAt !== null) {
      throw new NotFoundException(`Category not found: ${categoryId}`);
    }
  }
}
