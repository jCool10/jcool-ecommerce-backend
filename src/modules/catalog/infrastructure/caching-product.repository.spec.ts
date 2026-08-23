import type { ConfigService } from '@nestjs/config';
import type { CacheService } from '@shared/cache';
import { Money } from '@shared/kernel';
import type { CacheResult, MetricsPort } from '@shared/observability/metrics/metrics.port';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Product } from '../domain/entities';
import { CATALOG_CACHE_VERSION_KEY } from './catalog-cache.keys';
import { CachingProductRepository } from './caching-product.repository';
import type { DrizzleProductRepository } from './drizzle-product.repository';
import { toProductSnapshot, type ProductSnapshot } from './product-cache.codec';

const TTL_SECONDS = 60;

function buildProduct(slug = 'headphones'): Product {
  return new Product(
    'p-1',
    'Headphones',
    slug,
    null,
    'ACTIVE',
    { slug: 'audio', name: 'Audio' },
    [{ id: 'v-1', sku: 'WH-001', name: 'Black', prices: [Money.of(199_000, 'VND')] }],
    new Date('2026-08-12T09:41:00.000Z'),
  );
}

function build() {
  const source = {
    findManyActive: vi.fn(),
    findActiveByIdOrSlug: vi.fn(),
    findSkuView: vi.fn(),
  };
  const cache = {
    read: vi.fn().mockResolvedValue({ status: 'miss' }),
    write: vi.fn().mockResolvedValue(true),
    readCounter: vi.fn().mockResolvedValue(0),
    bumpCounter: vi.fn().mockResolvedValue(undefined),
  };
  const recordCatalogCacheOperation = vi.fn<(result: CacheResult) => void>();
  const repo = new CachingProductRepository(
    source as unknown as DrizzleProductRepository,
    cache as unknown as CacheService,
    { recordCatalogCacheOperation } as unknown as MetricsPort,
    { getOrThrow: () => TTL_SECONDS } as unknown as ConfigService,
  );
  return { repo, source, cache, recordCatalogCacheOperation };
}

describe('CachingProductRepository', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('findActiveByIdOrSlug', () => {
    it('misses on a cold key, reads through, and stores the snapshot under the TTL', async () => {
      const product = buildProduct();
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.write).toHaveBeenCalledWith(
        expect.stringContaining(':product:headphones'),
        toProductSnapshot(product),
        TTL_SECONDS,
      );
    });

    it('serves a hit from the snapshot without touching the source', async () => {
      const product = buildProduct();
      const wire = JSON.parse(JSON.stringify(toProductSnapshot(product))) as ProductSnapshot;
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: wire });

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(ctx.source.findActiveByIdOrSlug).not.toHaveBeenCalled();
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('hit');
      expect(result).toEqual(product);
      expect(result?.variants[0].prices[0]).toBeInstanceOf(Money);
    });

    it('does not cache a 404 — an unknown slug must not evict live products', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(null);

      await expect(ctx.repo.findActiveByIdOrSlug('no-such-slug')).resolves.toBeNull();

      expect(ctx.cache.write).not.toHaveBeenCalled();
    });

    it('falls through to the source when the generation counter is unreachable', async () => {
      const product = buildProduct();
      ctx.cache.readCounter.mockResolvedValue(null);
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('error');
      // Nothing is read or written under a fabricated generation a recovered Redis would disown.
      expect(ctx.cache.read).not.toHaveBeenCalled();
      expect(ctx.cache.write).not.toHaveBeenCalled();
    });

    it('discards an undecodable snapshot and refills from the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: { id: 'p-1', variants: 'not-an-array' } });
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.write).toHaveBeenCalled();
    });

    // The dangerous drift is the one that still decodes: a snapshot missing only `category`
    // used to build a Product with an undefined field and 500 later, in the response mapper.
    it('discards a snapshot missing a field the entity never validates', async () => {
      const product = buildProduct();
      const { category: _dropped, ...withoutCategory } = toProductSnapshot(product);
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: withoutCategory });
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.write).toHaveBeenCalled();
    });

    it('reports an error when Redis rejects the read, and still serves from the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue({ status: 'error' });
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      await expect(ctx.repo.findActiveByIdOrSlug('headphones')).resolves.toBe(product);

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('error');
      expect(ctx.recordCatalogCacheOperation).not.toHaveBeenCalledWith('miss');
    });

    it('reports an error when the refill is rejected, so a write-only outage is not a silent miss', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
      ctx.cache.write.mockResolvedValue(false);

      await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('error');
      expect(ctx.recordCatalogCacheOperation).not.toHaveBeenCalledWith('miss');
    });

    it('folds id case into one key — Postgres matches a uuid case-insensitively', async () => {
      const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());

      await ctx.repo.findActiveByIdOrSlug(id.toUpperCase());
      await ctx.repo.findActiveByIdOrSlug(id);

      const keys = ctx.cache.write.mock.calls.map((call) => call[0] as string);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toContain(id);
    });

    it('keeps slug case distinct — a slug is text, where case decides which product answers', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());

      await ctx.repo.findActiveByIdOrSlug('Headphones');
      await ctx.repo.findActiveByIdOrSlug('headphones');

      const keys = ctx.cache.write.mock.calls.map((call) => call[0] as string);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('keys a bumped generation separately, so the pre-bump entry is unreachable', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
      await ctx.repo.findActiveByIdOrSlug('headphones');
      const beforeBump = ctx.cache.write.mock.calls[0][0] as string;

      ctx.cache.readCounter.mockResolvedValue(1);
      await ctx.repo.findActiveByIdOrSlug('headphones');
      const afterBump = ctx.cache.write.mock.calls[1][0] as string;

      expect(afterBump).not.toBe(beforeBump);
      expect(ctx.cache.readCounter).toHaveBeenCalledWith(CATALOG_CACHE_VERSION_KEY);
    });
  });

  describe('findManyActive', () => {
    const criteria = { page: 1, pageSize: 20 };

    it('reads through on a miss and caches items plus total', async () => {
      const product = buildProduct();
      ctx.source.findManyActive.mockResolvedValue({ items: [product], total: 1 });

      const result = await ctx.repo.findManyActive(criteria);

      expect(result.total).toBe(1);
      expect(ctx.cache.write).toHaveBeenCalledWith(
        expect.stringContaining(':list:'),
        { items: [toProductSnapshot(product)], total: 1 },
        TTL_SECONDS,
      );
    });

    it('serves a hit without touching the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: { items: [toProductSnapshot(product)], total: 1 } });

      const result = await ctx.repo.findManyActive(criteria);

      expect(ctx.source.findManyActive).not.toHaveBeenCalled();
      expect(result).toEqual({ items: [product], total: 1 });
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('hit');
    });

    it('separates keys per criteria so a filtered page cannot serve an unfiltered one', async () => {
      ctx.source.findManyActive.mockResolvedValue({ items: [], total: 0 });

      await ctx.repo.findManyActive(criteria);
      await ctx.repo.findManyActive({ ...criteria, q: 'phone' });
      await ctx.repo.findManyActive({ ...criteria, categorySlug: 'audio' });
      await ctx.repo.findManyActive({ ...criteria, page: 2 });

      const keys = ctx.cache.write.mock.calls.map((call) => call[0] as string);
      expect(new Set(keys).size).toBe(4);
    });
  });

  it('leaves findSkuView uncached — the cart prices a line off live data', async () => {
    const view = { skuId: 'v-1', productName: 'Headphones', unitPriceMinor: 199_000, currency: 'VND', isActive: true };
    ctx.source.findSkuView.mockResolvedValue(view);

    await expect(ctx.repo.findSkuView('v-1')).resolves.toBe(view);

    expect(ctx.cache.read).not.toHaveBeenCalled();
    expect(ctx.cache.write).not.toHaveBeenCalled();
  });
});
