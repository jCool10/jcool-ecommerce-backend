import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SwrCacheService, type CacheService, type SingleFlightLock } from '@shared/cache';
import { Money } from '@shared/kernel';
import type { CacheResult, MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Product } from '../domain/entities';
import { CATALOG_CACHE_VERSION_KEY } from './catalog-cache.keys';
import { CachingProductRepository } from './caching-product.repository';
import type { DrizzleProductRepository } from './drizzle-product.repository';
import { toProductSnapshot } from './product-cache.codec';

const CONFIG: Record<string, number> = {
  // Deliberately different from the shared default below, so the catalog override is observable.
  'catalog.cacheTtlSec': 60,
  'cache.softTtlMs': 999_000,
  'cache.staleWindowMs': 30_000,
  'cache.jitterMs': 0,
  'cache.leaseMs': 5_000,
  'cache.waitMs': 0,
};

const HARD_TTL_MS = 90_000;

// Rebuilt here rather than called from `catalog-cache.keys`: asserting against the same helper the
// code under test called would hold for any implementation of it, a constant included. `lookup` is
// what the key generator is expected to have already normalized (uuids folded to lower case).
function detailKey(version: number, lookup: string): string {
  return `catalog:v2:${version}:product:${createHash('sha256').update(lookup).digest('hex').slice(0, 32)}`;
}

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

function fresh(data: unknown) {
  return { status: 'hit' as const, value: { data, freshUntil: Date.now() + 60_000 } };
}

function stale(data: unknown) {
  return { status: 'hit' as const, value: { data, freshUntil: Date.now() - 1 } };
}

function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function build() {
  const source = {
    findManyActive: vi.fn(),
    findActiveByIdOrSlug: vi.fn(),
    findSkuView: vi.fn(),
    findManySkuViews: vi.fn(),
  };
  const cache = {
    read: vi.fn().mockResolvedValue({ status: 'miss' }),
    writeMs: vi.fn().mockResolvedValue(true),
    readCounter: vi.fn().mockResolvedValue(0),
    bumpCounter: vi.fn().mockResolvedValue(undefined),
  };
  // Uncontended by default: the lock has its own unit tests, and most cases here are one caller.
  const lock = {
    acquire: vi.fn().mockResolvedValue({ status: 'acquired', token: 't' }),
    isHeld: vi.fn().mockResolvedValue(false),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const recordCatalogCacheOperation = vi.fn<(result: CacheResult) => void>();
  const metrics = { recordCatalogCacheOperation, observeCacheRebuild: vi.fn() } as unknown as MetricsPort;
  const config = { getOrThrow: (key: string) => CONFIG[key] } as unknown as ConfigService;
  const swr = new SwrCacheService(
    cache as unknown as CacheService,
    lock as unknown as SingleFlightLock,
    metrics,
    config,
    { warn: vi.fn() } as unknown as PinoLogger,
  );
  const repo = new CachingProductRepository(
    source as unknown as DrizzleProductRepository,
    cache as unknown as CacheService,
    swr,
    metrics,
    config,
  );
  return { repo, source, cache, lock, recordCatalogCacheOperation };
}

describe('CachingProductRepository', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('findActiveByIdOrSlug', () => {
    it('misses on a cold key, reads through, and stores the snapshot under the catalog TTL', async () => {
      const product = buildProduct();
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.writeMs).toHaveBeenCalledWith(
        detailKey(0, 'headphones'),
        expect.objectContaining({ data: toProductSnapshot(product) }),
        HARD_TTL_MS,
      );
    });

    it('serves a fresh hit from the snapshot without touching the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue(fresh(JSON.parse(JSON.stringify(toProductSnapshot(product)))));

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(ctx.source.findActiveByIdOrSlug).not.toHaveBeenCalled();
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('hit_fresh');
      expect(result).toEqual(product);
      expect(result?.variants[0].prices[0]).toBeInstanceOf(Money);
    });

    it('answers a stale hit immediately and refreshes it behind the caller', async () => {
      const cached = buildProduct();
      const renamed = buildProduct('headphones-renamed');
      ctx.cache.read.mockResolvedValue(stale(toProductSnapshot(cached)));
      // Resolved only after the read has answered: a caller that waited on the refresh would hang.
      let finishRebuild!: (product: Product) => void;
      const pending = new Promise<Product>((resolve) => {
        finishRebuild = resolve;
      });
      ctx.source.findActiveByIdOrSlug.mockReturnValue(pending);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toEqual(cached);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('hit_stale');

      finishRebuild(renamed);
      await flushBackgroundWork();
      expect(ctx.cache.writeMs).toHaveBeenCalledWith(
        detailKey(0, 'headphones'),
        expect.objectContaining({ data: toProductSnapshot(renamed) }),
        HARD_TTL_MS,
      );
    });

    it('does not cache a 404 — an unknown slug must not evict live products', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(null);

      await expect(ctx.repo.findActiveByIdOrSlug('no-such-slug')).resolves.toBeNull();

      expect(ctx.cache.writeMs).not.toHaveBeenCalled();
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
      expect(ctx.cache.writeMs).not.toHaveBeenCalled();
    });

    it('discards an undecodable snapshot and refills from the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue(fresh({ id: 'p-1', variants: 'not-an-array' }));
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.writeMs).toHaveBeenCalled();
    });

    // The dangerous drift is the one that still decodes — a Product with an undefined field.
    it('discards a snapshot missing a field the entity never validates', async () => {
      const product = buildProduct();
      const { category: _dropped, ...withoutCategory } = toProductSnapshot(product);
      ctx.cache.read.mockResolvedValue(fresh(withoutCategory));
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      const result = await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(result).toBe(product);
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
      expect(ctx.cache.writeMs).toHaveBeenCalled();
    });

    it('falls through without the lock when Redis rejects the read, and still serves from the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue({ status: 'error' });
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      await expect(ctx.repo.findActiveByIdOrSlug('headphones')).resolves.toBe(product);

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('error_fallthrough');
      expect(ctx.recordCatalogCacheOperation).not.toHaveBeenCalledWith('miss');
      expect(ctx.lock.acquire).not.toHaveBeenCalled();
    });

    it('reads through when another rebuilder holds the lock and stores nothing', async () => {
      const product = buildProduct();
      ctx.lock.acquire.mockResolvedValue({ status: 'held' });
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

      await expect(ctx.repo.findActiveByIdOrSlug('headphones')).resolves.toBe(product);

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('lock_wait');
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('lock_timeout');
    });

    it('reports a rejected refill, so a write-only outage is not a silent miss', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
      ctx.cache.writeMs.mockResolvedValue(false);

      await ctx.repo.findActiveByIdOrSlug('headphones');

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('store_rejected');
    });

    it('folds id case into one key — Postgres matches a uuid case-insensitively', async () => {
      const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());

      await ctx.repo.findActiveByIdOrSlug(id.toUpperCase());
      await ctx.repo.findActiveByIdOrSlug(id);

      const keys = ctx.cache.writeMs.mock.calls.map((call) => call[0] as string);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toBe(detailKey(0, id));
    });

    // The segment comes straight off the URL, and the single-flight lock appends `:lock` to whatever
    // key it is given, so an unhashed one would let a caller name another entry's lock.
    it('keeps the detail key bounded and free of the raw path segment', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
      const hostile = `${'x'.repeat(4_000)}:lock`;

      await ctx.repo.findActiveByIdOrSlug(hostile);

      const key = ctx.cache.writeMs.mock.calls[0][0] as string;
      expect(key).not.toContain(':lock');
      expect(key).toBe(detailKey(0, hostile));
      expect(key.length).toBeLessThan(80);
    });

    it('keeps slug case distinct — a slug is text, where case decides which product answers', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());

      await ctx.repo.findActiveByIdOrSlug('Headphones');
      await ctx.repo.findActiveByIdOrSlug('headphones');

      const keys = ctx.cache.writeMs.mock.calls.map((call) => call[0] as string);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('keys a bumped generation separately, so the pre-bump entry is unreachable', async () => {
      ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
      await ctx.repo.findActiveByIdOrSlug('headphones');
      const beforeBump = ctx.cache.writeMs.mock.calls[0][0] as string;

      ctx.cache.readCounter.mockResolvedValue(1);
      await ctx.repo.findActiveByIdOrSlug('headphones');
      const afterBump = ctx.cache.writeMs.mock.calls[1][0] as string;

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
      expect(ctx.cache.writeMs).toHaveBeenCalledWith(
        expect.stringContaining(':list:'),
        expect.objectContaining({ data: { items: [toProductSnapshot(product)], total: 1 } }),
        HARD_TTL_MS,
      );
    });

    it('serves a fresh hit without touching the source', async () => {
      const product = buildProduct();
      ctx.cache.read.mockResolvedValue(fresh({ items: [toProductSnapshot(product)], total: 1 }));

      const result = await ctx.repo.findManyActive(criteria);

      expect(ctx.source.findManyActive).not.toHaveBeenCalled();
      expect(result).toEqual({ items: [product], total: 1 });
      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('hit_fresh');
    });

    it('discards a list snapshot whose total no longer decodes', async () => {
      ctx.cache.read.mockResolvedValue(fresh({ items: [], total: 'many' }));
      ctx.source.findManyActive.mockResolvedValue({ items: [], total: 0 });

      await expect(ctx.repo.findManyActive(criteria)).resolves.toEqual({ items: [], total: 0 });

      expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('miss');
    });

    it('separates keys per criteria so a filtered page cannot serve an unfiltered one', async () => {
      ctx.source.findManyActive.mockResolvedValue({ items: [], total: 0 });

      await ctx.repo.findManyActive(criteria);
      await ctx.repo.findManyActive({ ...criteria, q: 'phone' });
      await ctx.repo.findManyActive({ ...criteria, categorySlug: 'audio' });
      await ctx.repo.findManyActive({ ...criteria, page: 2 });

      const keys = ctx.cache.writeMs.mock.calls.map((call) => call[0] as string);
      expect(new Set(keys).size).toBe(4);
    });
  });

  it('leaves findSkuView uncached — the cart and the order both price a line off live data', async () => {
    const view = { skuId: 'v-1', productName: 'Headphones', unitPriceMinor: 199_000, currency: 'VND', isActive: true };
    ctx.source.findSkuView.mockResolvedValue(view);

    await expect(ctx.repo.findSkuView('v-1')).resolves.toBe(view);

    expect(ctx.cache.read).not.toHaveBeenCalled();
    expect(ctx.cache.writeMs).not.toHaveBeenCalled();
  });

  it('leaves findManySkuViews uncached too — batching a whole cart must not make its prices stale', async () => {
    const views = [
      { skuId: 'v-1', productName: 'Headphones', unitPriceMinor: 199_000, currency: 'VND', isActive: true },
      { skuId: 'v-2', productName: 'Cable', unitPriceMinor: 49_000, currency: 'VND', isActive: true },
    ];
    ctx.source.findManySkuViews.mockResolvedValue(views);

    await expect(ctx.repo.findManySkuViews(['v-1', 'v-2'])).resolves.toBe(views);

    expect(ctx.source.findManySkuViews).toHaveBeenCalledWith(['v-1', 'v-2']);
    expect(ctx.cache.read).not.toHaveBeenCalled();
    expect(ctx.cache.writeMs).not.toHaveBeenCalled();
  });
});
