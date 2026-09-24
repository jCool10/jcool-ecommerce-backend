import type { CacheService } from '@shared/cache';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CATALOG_CACHE_VERSION_KEY } from './catalog-cache.keys';
import { CachingCatalogAdminRepository } from './caching-catalog-admin.repository';
import type { DrizzleCatalogAdminRepository } from './drizzle-catalog-admin.repository';

const MUTATIONS = [
  'createCategory',
  'updateCategory',
  'archiveCategoryIfEmpty',
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

const PASSTHROUGH_READS = ['findCategoryById', 'findProductById', 'findSkuById', 'listImages'] as const;

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type AnyMethod = (...args: unknown[]) => Promise<unknown>;

function build() {
  const source = Object.fromEntries(
    [...MUTATIONS, ...PASSTHROUGH_READS].map((name) => [
      name,
      vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'x' }),
    ]),
  ) as Record<string, AsyncMock>;
  // The archive answers with an outcome rather than a row: a refusal is not a missing category.
  source.archiveCategoryIfEmpty.mockResolvedValue({ category: { id: 'x' }, blocked: false });
  const bumpCounter = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
  const repo = new CachingCatalogAdminRepository(
    source as unknown as DrizzleCatalogAdminRepository,
    { bumpCounter } as unknown as CacheService,
  );
  const call = (method: string, ...args: unknown[]) => (repo[method as keyof typeof repo] as AnyMethod)(...args);
  return { call, source, bumpCounter };
}

describe('CachingCatalogAdminRepository', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('bumps the catalog generation once after each committed mutation', async () => {
    for (const mutation of MUTATIONS) {
      ctx.bumpCounter.mockClear();

      // A non-empty payload: the update methods treat an all-undefined patch as a no-op.
      await ctx.call(mutation, 'id', { name: 'x' });

      expect(ctx.bumpCounter, mutation).toHaveBeenCalledExactlyOnceWith(CATALOG_CACHE_VERSION_KEY);
    }
  });

  it('leaves the generation alone on reads', async () => {
    for (const read of PASSTHROUGH_READS) {
      await ctx.call(read, 'id');
      expect(ctx.source[read], read).toHaveBeenCalled();
    }

    expect(ctx.bumpCounter).not.toHaveBeenCalled();
  });

  it('declares every port method as either a mutation or a read', () => {
    const declared = new Set<string>([...MUTATIONS, ...PASSTHROUGH_READS]);
    const implemented = Object.getOwnPropertyNames(CachingCatalogAdminRepository.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('invalidating'),
    );

    expect(implemented.filter((name) => !declared.has(name))).toEqual([]);
  });

  // The adapter turns a patch with nothing defined into a plain read that returns the existing row,
  // so a non-null result alone does not mean something changed.
  it('does not bump for an update that carries no field to write', async () => {
    await ctx.call('updateProduct', 'id', {});
    await ctx.call('updateCategory', 'id', { name: undefined });
    await ctx.call('updateSku', 'id', {});

    expect(ctx.bumpCounter).not.toHaveBeenCalled();
  });

  it('does not bump when a category archive is refused or the category is unknown', async () => {
    ctx.source.archiveCategoryIfEmpty
      .mockResolvedValueOnce({ category: null, blocked: true })
      .mockResolvedValueOnce({ category: null, blocked: false });

    await ctx.call('archiveCategoryIfEmpty', 'cat1');
    await ctx.call('archiveCategoryIfEmpty', 'missing');

    expect(ctx.bumpCounter).not.toHaveBeenCalled();
  });

  it('bumps only after the write resolves', async () => {
    const order: string[] = [];
    ctx.source.archiveProduct.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({ id: 'p-1' });
    });
    ctx.bumpCounter.mockImplementation(() => {
      order.push('bump');
      return Promise.resolve();
    });

    await ctx.call('archiveProduct', 'p-1');

    expect(order).toEqual(['write', 'bump']);
  });
});
