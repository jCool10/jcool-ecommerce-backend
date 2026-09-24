import { createHash } from 'node:crypto';
import { SwrCacheService, type CacheService, type SingleFlightLock } from '@shared/cache';
import { Money } from '@jcool/kernel';
import type { CacheResult } from '@jcool/metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Product } from '../domain/entities';
import { CachingProductRepository } from './caching-product.repository';
import type { DrizzleProductRepository } from './drizzle-product.repository';
import { toProductSnapshot } from './product-cache.codec';

const CONFIG: Record<string, number> = {
  // Different from the shared default below, so the catalog override is observable.
  'catalog.cacheTtlSec': 60,
  'cache.softTtlMs': 999_000,
  'cache.staleWindowMs': 30_000,
  'cache.jitterMs': 0,
  'cache.leaseMs': 5_000,
  'cache.waitMs': 0,
};

const HARD_TTL_MS = 90_000;

// Rebuilt here rather than imported from `catalog-cache.keys`: asserting against the helper the
// code under test calls would hold for any implementation of it. `lookup` is what the key generator
// should already have normalised (uuids folded to lower case).
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
  // Uncontended: the lock has its own unit tests, and every case here is one caller.
  const lock = {
    acquire: vi.fn().mockResolvedValue({ status: 'acquired', token: 't' }),
    isHeld: vi.fn().mockResolvedValue(false),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const recordCatalogCacheOperation = vi.fn<(result: CacheResult) => void>();
  const metrics = fakeMetricsPort({ recordCatalogCacheOperation });
  const config = fakeConfigService(CONFIG);
  const swr = new SwrCacheService(
    cache as unknown as CacheService,
    lock as unknown as SingleFlightLock,
    metrics,
    config,
    fakePinoLogger(),
  );
  const repo = new CachingProductRepository(
    source as unknown as DrizzleProductRepository,
    cache as unknown as CacheService,
    swr,
    metrics,
    config,
  );
  const writtenKeys = () => cache.writeMs.mock.calls.map((call) => call[0] as string);
  return { repo, source, cache, recordCatalogCacheOperation, writtenKeys };
}

describe('CachingProductRepository', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('reads through a cold key and stores the snapshot under the catalog TTL', async () => {
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

  it('falls through to the source when the generation counter is unreachable', async () => {
    const product = buildProduct();
    ctx.cache.readCounter.mockResolvedValue(null);
    ctx.source.findActiveByIdOrSlug.mockResolvedValue(product);

    const result = await ctx.repo.findActiveByIdOrSlug('headphones');

    expect(result).toBe(product);
    expect(ctx.recordCatalogCacheOperation).toHaveBeenCalledWith('error');
    // Nothing is read or written under a made-up generation that a recovered Redis would disown.
    expect(ctx.cache.read).not.toHaveBeenCalled();
    expect(ctx.cache.writeMs).not.toHaveBeenCalled();
  });

  // The dangerous drift is the one that still decodes: a Product with an undefined field.
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

  // Postgres compares a uuid case-insensitively but a slug as text, where case picks the product.
  it('folds uuid case into one key but keeps slug case distinct', async () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());

    for (const lookup of [id.toUpperCase(), id, 'Headphones', 'headphones']) {
      await ctx.repo.findActiveByIdOrSlug(lookup);
    }

    expect(ctx.writtenKeys()).toEqual([
      detailKey(0, id),
      detailKey(0, id),
      detailKey(0, 'Headphones'),
      detailKey(0, 'headphones'),
    ]);
  });

  // The segment comes straight off the URL, and the single-flight lock appends `:lock` to whatever
  // key it is given, so an unhashed one would let a caller name another entry's lock.
  it('keeps the detail key bounded and free of the raw path segment', async () => {
    ctx.source.findActiveByIdOrSlug.mockResolvedValue(buildProduct());
    const hostile = `${'x'.repeat(4_000)}:lock`;

    await ctx.repo.findActiveByIdOrSlug(hostile);

    const [key] = ctx.writtenKeys();
    expect(key).not.toContain(':lock');
    expect(key).toBe(detailKey(0, hostile));
    expect(key.length).toBeLessThan(80);
  });

  // A field missing from the fingerprint would let a filtered page answer for an unfiltered one.
  it('keys each list criteria combination separately', async () => {
    const criteria = { page: 1, pageSize: 20 };
    ctx.source.findManyActive.mockResolvedValue({ items: [], total: 0 });

    await ctx.repo.findManyActive(criteria);
    await ctx.repo.findManyActive({ ...criteria, q: 'phone' });
    await ctx.repo.findManyActive({ ...criteria, categorySlug: 'audio' });
    await ctx.repo.findManyActive({ ...criteria, page: 2 });

    expect(new Set(ctx.writtenKeys()).size).toBe(4);
  });

  // Cart prices a line off these reads and Order snapshots the price it charges from them.
  it('reads SKU views from the source, never from the cache', async () => {
    const view = { skuId: 'v-1', productName: 'Headphones', unitPriceMinor: 199_000, currency: 'VND', isActive: true };
    ctx.source.findSkuView.mockResolvedValue(view);
    ctx.source.findManySkuViews.mockResolvedValue([view]);

    await expect(ctx.repo.findSkuView('v-1')).resolves.toBe(view);
    await expect(ctx.repo.findManySkuViews(['v-1'])).resolves.toEqual([view]);

    expect(ctx.cache.read).not.toHaveBeenCalled();
    expect(ctx.cache.writeMs).not.toHaveBeenCalled();
  });
});
