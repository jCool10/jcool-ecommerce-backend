import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AdminProduct, Category, Price, Sku } from '../../domain/entities/catalog-admin.entities';
import type { CatalogAdminRepositoryPort } from '../ports/catalog-admin-repository.port';
import { CatalogAdminService } from './catalog-admin.service';

// Pins the service's business decisions over a mocked port: 404 for missing refs
// and 409 for a refused archive (unique-violation 409s live in the adapter).
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

  // Members typed as plain `jest.Mock` so `expect(repo.method)` isn't flagged as
  // an unbound method; `keyof` still pins the port shape.
  type MockRepo = Record<keyof CatalogAdminRepositoryPort, jest.Mock>;
  function makeRepo(): MockRepo {
    return {
      findCategoryById: jest.fn(),
      createCategory: jest.fn(),
      updateCategory: jest.fn(),
      archiveCategory: jest.fn(),
      countActiveProductsInCategory: jest.fn(),
      findProductById: jest.fn(),
      createProduct: jest.fn(),
      updateProduct: jest.fn(),
      archiveProduct: jest.fn(),
      findSkuById: jest.fn(),
      createSku: jest.fn(),
      updateSku: jest.fn(),
      archiveSku: jest.fn(),
      setPrice: jest.fn(),
    };
  }

  let repo: MockRepo;
  let service: CatalogAdminService;

  beforeEach(() => {
    repo = makeRepo();
    service = new CatalogAdminService(repo);
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
      repo.countActiveProductsInCategory.mockResolvedValue(2);
      await expect(service.archiveCategory('cat1')).rejects.toBeInstanceOf(ConflictException);
      expect(repo.archiveCategory).not.toHaveBeenCalled();
    });

    it('archives when no active products remain', async () => {
      repo.countActiveProductsInCategory.mockResolvedValue(0);
      repo.archiveCategory.mockResolvedValue(category({ archivedAt: now }));
      await expect(service.archiveCategory('cat1')).resolves.toEqual(category({ archivedAt: now }));
    });

    it('rejects with 404 when the category id is unknown', async () => {
      repo.countActiveProductsInCategory.mockResolvedValue(0);
      repo.archiveCategory.mockResolvedValue(null);
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
});
