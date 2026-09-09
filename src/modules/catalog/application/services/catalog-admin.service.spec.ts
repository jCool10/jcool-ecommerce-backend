import { ConflictException, NotFoundException } from '@nestjs/common';
import { Money } from '@shared/kernel';
import { type Mock, vi } from 'vitest';
import { Product } from '../../domain/entities';
import type { AdminProduct, Category, Price, Sku } from '../../domain/entities';
import type { CatalogAdminRepositoryPort, CatalogSearchPort, ProductRepositoryPort } from '../ports';
import { CatalogAdminService } from './catalog-admin.service';

describe('CatalogAdminService', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const category = (over: Partial<Category> = {}): Category => ({
    id: 'cat1',
    name: 'Electronics',
    slug: 'electronics',
    parentId: null,
    archivedAt: null,
    createdAt: now,
    ...over,
  });
  const product = (over: Partial<AdminProduct> = {}): AdminProduct => ({
    id: 'prod1',
    name: 'Headphones',
    slug: 'headphones',
    description: null,
    status: 'DRAFT',
    categoryId: 'cat1',
    createdAt: now,
    ...over,
  });
  const sku = (over: Partial<Sku> = {}): Sku => ({
    id: 'sku1',
    sku: 'WH-BLK',
    name: 'Black',
    productId: 'prod1',
    archivedAt: null,
    createdAt: now,
    ...over,
  });
  const activeProjection = (): Product =>
    new Product(
      'prod1',
      'Headphones',
      'headphones',
      null,
      'ACTIVE',
      { slug: 'electronics', name: 'Electronics' },
      [{ id: 'sku1', sku: 'WH-BLK', name: 'Black', prices: [Money.of(1_990_000, 'VND')] }],
      now,
    );

  // Plain `Mock` members so `expect(repo.method)` isn't flagged as an unbound method; `keyof` still
  // pins the port shape.
  type MockRepo = Record<keyof CatalogAdminRepositoryPort, Mock>;
  function makeRepo(): MockRepo {
    return {
      findCategoryById: vi.fn(),
      createCategory: vi.fn(),
      updateCategory: vi.fn(),
      archiveCategoryIfEmpty: vi.fn(),
      findProductById: vi.fn(),
      createProduct: vi.fn(),
      updateProduct: vi.fn(),
      archiveProduct: vi.fn(),
      findSkuById: vi.fn(),
      createSku: vi.fn(),
      updateSku: vi.fn(),
      archiveSku: vi.fn(),
      listImages: vi.fn(),
      attachImage: vi.fn(),
      detachImage: vi.fn(),
      reorderImages: vi.fn(),
      setPrice: vi.fn(),
    };
  }

  type MockProducts = Record<keyof ProductRepositoryPort, Mock>;
  type MockSearch = Record<keyof CatalogSearchPort, Mock>;

  let repo: MockRepo;
  let products: MockProducts;
  let search: MockSearch;
  let service: CatalogAdminService;

  beforeEach(() => {
    repo = makeRepo();
    products = {
      findManyActive: vi.fn(),
      // Default: nothing publicly visible, so a mutation's write-through resolves to a delete
      // unless a test says the product is ACTIVE.
      findActiveByIdOrSlug: vi.fn().mockResolvedValue(null),
      findActiveAfter: vi.fn(),
      findSkuView: vi.fn(),
      findManySkuViews: vi.fn(),
    };
    search = {
      ensureIndex: vi.fn().mockResolvedValue(undefined),
      resetIndex: vi.fn().mockResolvedValue(undefined),
      bulkIndex: vi.fn().mockResolvedValue(undefined),
      indexProduct: vi.fn().mockResolvedValue(undefined),
      deleteProduct: vi.fn().mockResolvedValue(undefined),
      search: vi.fn(),
    };
    service = new CatalogAdminService(repo, products, search);
  });

  describe('createProduct', () => {
    it('rejects with 404 when the category does not exist', async () => {
      repo.findCategoryById.mockResolvedValue(null);
      await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'missing' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.createProduct).not.toHaveBeenCalled();
    });

    it('rejects with 404 when the category is archived', async () => {
      repo.findCategoryById.mockResolvedValue(category({ archivedAt: now }));
      await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'cat1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.createProduct).not.toHaveBeenCalled();
    });

    it('creates when the category exists and is active', async () => {
      repo.findCategoryById.mockResolvedValue(category());
      repo.createProduct.mockResolvedValue(product());
      await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'cat1' })).resolves.toEqual(product());
    });
  });

  describe('updateProduct', () => {
    it('rejects with 404 when the product does not exist', async () => {
      repo.updateProduct.mockResolvedValue(null);
      await expect(service.updateProduct('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates a newly referenced category before updating', async () => {
      repo.findCategoryById.mockResolvedValue(null);
      await expect(service.updateProduct('prod1', { categoryId: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateProduct).not.toHaveBeenCalled();
    });
  });

  describe('archiveProduct', () => {
    it('rejects with 404 when the product does not exist', async () => {
      repo.archiveProduct.mockResolvedValue(null);
      await expect(service.archiveProduct('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('archiveCategory', () => {
    it('rejects with 409 when the category still has active products', async () => {
      repo.archiveCategoryIfEmpty.mockResolvedValue({ category: null, blocked: true });
      await expect(service.archiveCategory('cat1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('archives when no active products remain', async () => {
      repo.archiveCategoryIfEmpty.mockResolvedValue({ category: category({ archivedAt: now }), blocked: false });
      await expect(service.archiveCategory('cat1')).resolves.toEqual(category({ archivedAt: now }));
    });

    it('rejects with 404 when the category id is unknown', async () => {
      repo.archiveCategoryIfEmpty.mockResolvedValue({ category: null, blocked: false });
      await expect(service.archiveCategory('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createSku', () => {
    it('rejects with 404 when the parent product does not exist', async () => {
      repo.findProductById.mockResolvedValue(null);
      await expect(service.createSku('missing', { sku: 'X', name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createSku).not.toHaveBeenCalled();
    });

    it('creates under an existing product', async () => {
      repo.findProductById.mockResolvedValue(product());
      repo.createSku.mockResolvedValue(sku());
      await expect(service.createSku('prod1', { sku: 'WH-BLK', name: 'Black' })).resolves.toEqual(sku());
    });
  });

  describe('setPrice', () => {
    it('rejects with 404 when the SKU does not exist', async () => {
      repo.findSkuById.mockResolvedValue(null);
      await expect(service.setPrice('missing', { amountMinor: 1000 })).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setPrice).not.toHaveBeenCalled();
    });

    it('defaults the currency to VND when omitted', async () => {
      repo.findSkuById.mockResolvedValue(sku());
      const price: Price = { variantId: 'sku1', currency: 'VND', amountMinor: 1000 };
      repo.setPrice.mockResolvedValue(price);
      await service.setPrice('sku1', { amountMinor: 1000 });
      expect(repo.setPrice).toHaveBeenCalledWith('sku1', { currency: 'VND', amountMinor: 1000 });
    });

    it('passes an explicit currency through unchanged', async () => {
      repo.findSkuById.mockResolvedValue(sku());
      repo.setPrice.mockResolvedValue({ variantId: 'sku1', currency: 'USD', amountMinor: 500 });
      await service.setPrice('sku1', { amountMinor: 500, currency: 'USD' });
      expect(repo.setPrice).toHaveBeenCalledWith('sku1', { currency: 'USD', amountMinor: 500 });
    });
  });

  describe('search write-through', () => {
    it('indexes the re-read ACTIVE projection after a product write', async () => {
      repo.findCategoryById.mockResolvedValue(category());
      repo.createProduct.mockResolvedValue(product({ status: 'ACTIVE' }));
      products.findActiveByIdOrSlug.mockResolvedValue(activeProjection());

      await service.createProduct({ name: 'P', slug: 'p', status: 'ACTIVE', categoryId: 'cat1' });

      expect(products.findActiveByIdOrSlug).toHaveBeenCalledWith('prod1');
      expect(search.indexProduct).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'prod1', skus: ['WH-BLK'], minPriceMinor: 1_990_000 }),
      );
      expect(search.deleteProduct).not.toHaveBeenCalled();
    });

    it('deletes the document when the product is no longer publicly visible', async () => {
      repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));

      await service.archiveProduct('prod1');

      expect(search.deleteProduct).toHaveBeenCalledWith('prod1');
      expect(search.indexProduct).not.toHaveBeenCalled();
    });

    it('indexes after a successful product update', async () => {
      repo.updateProduct.mockResolvedValue(product({ status: 'ACTIVE' }));
      products.findActiveByIdOrSlug.mockResolvedValue(activeProjection());

      await service.updateProduct('prod1', { name: 'Headphones II' });

      expect(search.indexProduct).toHaveBeenCalledWith(expect.objectContaining({ id: 'prod1' }));
    });

    it('deletes the document when a product is unpublished to DRAFT', async () => {
      repo.updateProduct.mockResolvedValue(product({ status: 'DRAFT' }));

      await service.updateProduct('prod1', { status: 'DRAFT' });

      expect(search.deleteProduct).toHaveBeenCalledWith('prod1');
      expect(search.indexProduct).not.toHaveBeenCalled();
    });

    it('re-indexes the parent product after a SKU is renamed', async () => {
      repo.updateSku.mockResolvedValue(sku({ productId: 'parent-prod' }));

      await service.updateSku('sku1', { name: 'Midnight Black' });

      expect(products.findActiveByIdOrSlug).toHaveBeenCalledWith('parent-prod');
    });

    // The parent comes from the created row, not the argument, so the two differ here on purpose.
    it('re-indexes the created SKU parent rather than the SKU itself', async () => {
      repo.findProductById.mockResolvedValue(product());
      repo.createSku.mockResolvedValue(sku({ id: 'sku9', productId: 'parent-prod' }));

      await service.createSku('prod1', { sku: 'WH-RED', name: 'Red' });

      expect(products.findActiveByIdOrSlug).toHaveBeenCalledWith('parent-prod');
    });

    // findActiveByIdOrSlug also matches on slug, so a product whose slug equals this id would answer
    // for it once the real row leaves the ACTIVE set — indexing that stranger under the wrong id.
    it('deletes rather than indexing when another product answers on a colliding slug', async () => {
      repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));
      const impostor = activeProjection();
      products.findActiveByIdOrSlug.mockResolvedValue(
        new Product(
          'other-prod',
          impostor.name,
          'prod1',
          impostor.description,
          impostor.status,
          impostor.category,
          impostor.variants,
          impostor.createdAt,
        ),
      );

      await service.archiveProduct('prod1');

      expect(search.indexProduct).not.toHaveBeenCalled();
      expect(search.deleteProduct).toHaveBeenCalledWith('prod1');
    });

    it('re-indexes the parent product after a price change', async () => {
      repo.findSkuById.mockResolvedValue(sku({ productId: 'parent-prod' }));
      repo.setPrice.mockResolvedValue({ variantId: 'sku1', currency: 'VND', amountMinor: 1000 });

      await service.setPrice('sku1', { amountMinor: 1000 });

      expect(products.findActiveByIdOrSlug).toHaveBeenCalledWith('parent-prod');
    });

    it('re-indexes the parent product after a SKU is archived', async () => {
      repo.archiveSku.mockResolvedValue(sku({ productId: 'parent-prod', archivedAt: now }));

      await service.archiveSku('sku1');

      expect(products.findActiveByIdOrSlug).toHaveBeenCalledWith('parent-prod');
    });

    it('leaves the index alone when a category archive is allowed through', async () => {
      repo.archiveCategoryIfEmpty.mockResolvedValue({ category: category({ archivedAt: now }), blocked: false });

      await service.archiveCategory('cat1');

      expect(search.indexProduct).not.toHaveBeenCalled();
      expect(search.deleteProduct).not.toHaveBeenCalled();
    });

    it('still completes the mutation when the search engine is down', async () => {
      repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));
      search.deleteProduct.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(service.archiveProduct('prod1')).resolves.toEqual(product({ status: 'ARCHIVED' }));
    });

    it('still completes the mutation when the projection read for the document fails', async () => {
      repo.findCategoryById.mockResolvedValue(category());
      repo.createProduct.mockResolvedValue(product());
      products.findActiveByIdOrSlug.mockRejectedValue(new Error('db unavailable'));

      await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'cat1' })).resolves.toEqual(product());
    });
  });
});
