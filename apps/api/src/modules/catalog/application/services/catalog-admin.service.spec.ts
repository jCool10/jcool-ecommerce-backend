import { ConflictException, NotFoundException } from '@nestjs/common';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { type Mock, vi } from 'vitest';
import { MediaAssetUnavailableError } from '@modules/media/application/public/media-facade.port';
import type { AdminProduct, Category, Sku } from '../../domain/entities';
import type { CatalogAdminRepositoryPort, SetPriceData } from '../ports';
import { CatalogAdminService } from './catalog-admin.service';

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

// Plain `Mock` members so `expect(repo.method)` is not flagged as an unbound method; `keyof` still
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

function build() {
  const repo = makeRepo();
  const service = new CatalogAdminService(repo, fakePinoLogger());
  return { service, repo };
}

describe('CatalogAdminService', () => {
  it('refuses a missing or archived category with 404 before writing', async () => {
    const { service, repo } = build();
    repo.findCategoryById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(category({ archivedAt: now }))
      .mockResolvedValueOnce(null);

    await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.createProduct({ name: 'P', slug: 'p', categoryId: 'cat1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.updateProduct('prod1', { categoryId: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.createProduct).not.toHaveBeenCalled();
    expect(repo.updateProduct).not.toHaveBeenCalled();
  });

  it('answers 404 when the target of a write does not exist', async () => {
    const { service, repo } = build();
    for (const lookup of [
      repo.updateProduct,
      repo.archiveProduct,
      repo.updateCategory,
      repo.findProductById,
      repo.updateSku,
      repo.archiveSku,
      repo.detachImage,
      repo.findSkuById,
    ]) {
      lookup.mockResolvedValue(null);
    }
    const writes: [string, () => Promise<unknown>][] = [
      ['updateProduct', () => service.updateProduct('missing', { name: 'x' })],
      ['archiveProduct', () => service.archiveProduct('missing')],
      ['updateCategory', () => service.updateCategory('missing', { name: 'x' })],
      ['createSku', () => service.createSku('missing', { sku: 'X', name: 'X' })],
      ['updateSku', () => service.updateSku('missing', { name: 'x' })],
      ['archiveSku', () => service.archiveSku('missing')],
      ['detachProductImage', () => service.detachProductImage('prod1', 'missing')],
      ['setPrice', () => service.setPrice('missing', { amountMinor: 1000 })],
    ];

    const outcomes = await Promise.all(
      writes.map(async ([name, write]) => [
        name,
        await write().then(
          () => 'resolved',
          (error: unknown) => (error instanceof NotFoundException ? 404 : error),
        ),
      ]),
    );

    expect(outcomes).toEqual(writes.map(([name]) => [name, 404]));
    expect(repo.createSku).not.toHaveBeenCalled();
    expect(repo.setPrice).not.toHaveBeenCalled();
  });

  it('refuses a category archive with 409 while products remain, and 404 if unknown', async () => {
    const { service, repo } = build();
    repo.archiveCategoryIfEmpty
      .mockResolvedValueOnce({ category: null, blocked: true })
      .mockResolvedValueOnce({ category: null, blocked: false });

    await expect(service.archiveCategory('cat1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.archiveCategory('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an unavailable asset to 409 and keeps the original error as its cause', async () => {
    const { service, repo } = build();
    const original = new MediaAssetUnavailableError('Media asset asset1 is READY and cannot become ATTACHED', 'asset1');
    repo.findProductById.mockResolvedValue(product());
    repo.attachImage.mockRejectedValue(original);

    const rejection = service.attachProductImage('prod1', { assetId: 'asset1' });

    await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    await expect(rejection).rejects.toMatchObject({ cause: original });
  });

  it('prices in VND when the currency is omitted and keeps an explicit one', async () => {
    const { service, repo } = build();
    repo.findSkuById.mockResolvedValue(sku());
    repo.setPrice.mockImplementation((variantId: string, data: SetPriceData) =>
      Promise.resolve({ variantId, ...data }),
    );

    await expect(service.setPrice('sku1', { amountMinor: 1000 })).resolves.toEqual({
      variantId: 'sku1',
      currency: 'VND',
      amountMinor: 1000,
    });
    await expect(service.setPrice('sku1', { amountMinor: 500, currency: 'USD' })).resolves.toMatchObject({
      currency: 'USD',
    });
  });
});
