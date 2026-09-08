import type { CacheService } from '@shared/cache';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CATALOG_CACHE_VERSION_KEY } from './catalog-cache.keys';
import { CachingCatalogAdminRepository } from './caching-catalog-admin.repository';
import type { DrizzleCatalogAdminRepository } from './drizzle-catalog-admin.repository';

const MUTATIONS = [
  'createCategory',
  'updateCategory',
  'archiveCategory',
  'createProduct',
  'updateProduct',
  'archiveProduct',
  'createSku',
  'updateSku',
  'archiveSku',
  'attachImage',
  'detachImage',
  'reorderImages',
  'setPrice',
] as const;

const PASSTHROUGH_READS = [
  'findCategoryById',
  'countActiveProductsInCategory',
  'findProductById',
  'findSkuById',
  'listImages',
] as const;

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;

function build() {
  const source = Object.fromEntries(
    [...MUTATIONS, ...PASSTHROUGH_READS].map((name) => [
      name,
      vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'x' }),
    ]),
  ) as Record<string, AsyncMock>;
  const bumpCounter = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
  const repo = new CachingCatalogAdminRepository(
    source as unknown as DrizzleCatalogAdminRepository,
    {
      bumpCounter,
    } as unknown as CacheService,
  );
  return { repo, source, bumpCounter };
}

describe('CachingCatalogAdminRepository', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it.each(MUTATIONS)('bumps the catalog generation after %s commits', async (mutation) => {
    await (ctx.repo[mutation] as (...args: unknown[]) => Promise<unknown>)('id', {});

    expect(ctx.source[mutation]).toHaveBeenCalled();
    expect(ctx.bumpCounter).toHaveBeenCalledExactlyOnceWith(CATALOG_CACHE_VERSION_KEY);
  });

  it.each(PASSTHROUGH_READS)('leaves the generation alone on %s', async (read) => {
    await (ctx.repo[read] as (...args: unknown[]) => Promise<unknown>)('id');

    expect(ctx.source[read]).toHaveBeenCalled();
    expect(ctx.bumpCounter).not.toHaveBeenCalled();
  });

  it('classifies every port method — a new one must be declared a mutation or a read', () => {
    const declared = new Set<string>([...MUTATIONS, ...PASSTHROUGH_READS]);
    const implemented = Object.getOwnPropertyNames(CachingCatalogAdminRepository.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('invalidating'),
    );

    expect(implemented.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('does not bump when the id was unknown and nothing changed', async () => {
    ctx.source.updateProduct.mockResolvedValue(null);

    await expect(ctx.repo.updateProduct('missing', { name: 'x' })).resolves.toBeNull();

    expect(ctx.bumpCounter).not.toHaveBeenCalled();
  });

  it('bumps only after the write resolves, never before', async () => {
    const order: string[] = [];
    ctx.source.archiveProduct.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({ id: 'p-1' });
    });
    ctx.bumpCounter.mockImplementation(() => {
      order.push('bump');
      return Promise.resolve();
    });

    await ctx.repo.archiveProduct('p-1');

    expect(order).toEqual(['write', 'bump']);
  });
});
