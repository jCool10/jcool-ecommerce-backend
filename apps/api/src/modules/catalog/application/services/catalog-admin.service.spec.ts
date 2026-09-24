import { ConflictException, NotFoundException } from '@nestjs/common';
import { Money } from '@jcool/kernel';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { type Mock, vi } from 'vitest';
import { MediaAssetUnavailableError } from '@modules/media/application/public/media-facade.port';
import { Product } from '../../domain/entities';
import type { AdminProduct, Category, Sku } from '../../domain/entities';
import { fakeCatalogSearch, fakeProductRepository } from '../../testing/catalog-port.doubles';
import type {
  CatalogAdminRepositoryPort,
  CatalogSearchPort,
  ProductRepositoryPort,
  SearchableProduct,
  SetPriceData,
} from '../ports';
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

const activeProjection = (id = 'prod1', slug = 'headphones'): Product =>
  new Product(
    id,
    'Headphones',
    slug,
    null,
    'ACTIVE',
    { slug: 'electronics', name: 'Electronics' },
    [{ id: 'sku1', sku: 'WH-BLK', name: 'Black', prices: [Money.of(1_990_000, 'VND')] }],
    now,
  );

const answering = (projection: Product | null): Partial<ProductRepositoryPort> => ({
  findActiveByIdOrSlug: () => Promise.resolve(projection),
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

function build(products: Partial<ProductRepositoryPort> = {}, search: Partial<CatalogSearchPort> = {}) {
  const repo = makeRepo();
  const indexed: SearchableProduct[] = [];
  const deleted: string[] = [];
  const service = new CatalogAdminService(
    repo,
    fakeProductRepository(products),
    fakeCatalogSearch({
      indexProduct: (doc) => {
        indexed.push(doc);
        return Promise.resolve();
      },
      deleteProduct: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
      ...search,
    }),
    fakePinoLogger(),
  );
  return { service, repo, indexed, deleted };
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
    const { service, repo, indexed, deleted } = build();
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
    expect([...indexed, ...deleted]).toEqual([]);
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

  it('indexes the re-read ACTIVE projection after a product write', async () => {
    const { service, repo, indexed, deleted } = build(answering(activeProjection()));
    repo.findCategoryById.mockResolvedValue(category());
    repo.createProduct.mockResolvedValue(product({ status: 'ACTIVE' }));

    await service.createProduct({ name: 'P', slug: 'p', status: 'ACTIVE', categoryId: 'cat1' });

    expect(indexed).toEqual([expect.objectContaining({ id: 'prod1', skus: ['WH-BLK'], minPriceMinor: 1_990_000 })]);
    expect(deleted).toEqual([]);
  });

  // The projection lookup also matches on slug, so once prod1 leaves the ACTIVE set a product
  // slugged "prod1" answers for it, and indexing that one would file a stranger under prod1's id.
  it('deletes rather than indexes when another product answers on a colliding slug', async () => {
    const { service, repo, indexed, deleted } = build(answering(activeProjection('other-prod', 'prod1')));
    repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));

    await service.archiveProduct('prod1');

    expect(indexed).toEqual([]);
    expect(deleted).toEqual(['prod1']);
  });

  // A variant's name, SKU code and price are denormalised into its parent's document.
  it('re-syncs the parent product document after every SKU-level write', async () => {
    const { service, repo, indexed, deleted } = build(answering(activeProjection('parent-prod')));
    repo.findProductById.mockResolvedValue(product({ id: 'parent-prod' }));
    repo.createSku.mockResolvedValue(sku({ productId: 'parent-prod' }));
    repo.updateSku.mockResolvedValue(sku({ productId: 'parent-prod' }));
    repo.archiveSku.mockResolvedValue(sku({ productId: 'parent-prod', archivedAt: now }));
    repo.findSkuById.mockResolvedValue(sku({ productId: 'parent-prod' }));
    repo.setPrice.mockResolvedValue({ variantId: 'sku1', currency: 'VND', amountMinor: 1000 });

    await service.createSku('parent-prod', { sku: 'WH-RED', name: 'Red' });
    await service.updateSku('sku1', { name: 'Midnight Black' });
    await service.archiveSku('sku1');
    await service.setPrice('sku1', { amountMinor: 1000 });

    expect(indexed.map((doc) => doc.id)).toEqual(['parent-prod', 'parent-prod', 'parent-prod', 'parent-prod']);
    expect(deleted).toEqual([]);
  });

  // Best-effort dual write: `search:reindex` is the backstop for a document the sync missed.
  it('completes the mutation when the search sync fails', async () => {
    const readFails = build({ findActiveByIdOrSlug: () => Promise.reject(new Error('db unavailable')) });
    const engineDown = build({}, { deleteProduct: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    readFails.repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));
    engineDown.repo.archiveProduct.mockResolvedValue(product({ status: 'ARCHIVED' }));

    await expect(readFails.service.archiveProduct('prod1')).resolves.toEqual(product({ status: 'ARCHIVED' }));
    await expect(engineDown.service.archiveProduct('prod1')).resolves.toEqual(product({ status: 'ARCHIVED' }));
  });
});
