import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_CACHE_VERSION_KEY } from '../../src/modules/catalog/infrastructure/catalog-cache.keys';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure/drizzle-product.repository';
import { CacheService } from '../../src/shared/cache';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';
import { createTestApp } from '../setup/test-app.factory';

const HERD = 20;
// Longer than CACHE_LOCK_WAIT_MS and shorter than CACHE_LOCK_LEASE_MS: every waiter gives up while
// the holder is still legitimately working, which is the only interesting point between the two.
const SLOW_REBUILD_MS = 1_500;
const LOCK_WAIT_MS = 500;
const LOCK_LEASE_MS = 5_000;

async function readCacheCounter(app: INestApplication, result: string): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

/**
 * Two properties of the catalog cache that only show up at their edges: what the generation counter
 * means when Redis loses it, and what the single-flight lock is worth when the rebuild outlasts the
 * budget a waiter is given. Both are configuration-shaped, so both configurations are pinned here.
 */
describe('Catalog cache generation and lock budget (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let cache: CacheService;
  let redis: RedisService;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Pinned, not defaulted: the wait/lease relationship IS the assertion below, and a local .env
    // would otherwise decide it.
    app = await createTestApp({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: String(LOCK_WAIT_MS),
      CACHE_LOCK_LEASE_MS: String(LOCK_LEASE_MS),
    });
    pool = app.get<Pool>(PG_POOL);
    cache = app.get(CacheService);
    redis = app.get(RedisService);
    source = app.get(DrizzleProductRepository);
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What an `allkeys-lru` eviction does to a key that carries no TTL of its own. */
  const evictTheGenerationCounter = () => redis.getClient().del(CATALOG_CACHE_VERSION_KEY);

  const readProduct = (slug: string) => request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: once an admin write invalidates a cached snapshot, that snapshot is never
  //   served again.
  // Violated at: src/modules/catalog/infrastructure/catalog-cache.keys.ts:15-19 — invalidation is a
  //   generation counter mixed into every key, and it is deliberately TTL-less because losing it is
  //   unsafe. Losing it is exactly what an `allkeys-*` maxmemory policy does, and nothing enforces
  //   the policy: src/shared/cache/cache.service.ts:60-69 turns the absent key into generation 0
  //   (`Number(null)` is 0, and 0 is an integer) rather than into the `null` the Redis-outage path
  //   handles, so the cache silently rewinds into generations whose entries are still populated and
  //   re-serves what a write already invalidated — for CATALOG_CACHE_TTL_SEC plus the stale window
  //   and jitter, with no read able to tell the difference.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — CACHE-1 (and matrix q6:
  //   assert `maxmemory-policy` at boot, or give this key its own non-evictable store).
  it('rewinds to generation zero when the counter is evicted, re-serving a snapshot a write invalidated', async () => {
    // The state a fresh Redis (or an eviction) leaves: no counter at all.
    await evictTheGenerationCounter();
    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(0);

    const { productId, slug, name } = await createTestProduct(app);
    expect((await readProduct(slug)).body.name).toBe(name); // cached under generation 0

    const { accessToken } = await createTestAdmin(app);
    await request(app.getHttpServer())
      .patch(`/admin/products/${productId}`)
      .set(authHeader(accessToken))
      .send({ name: 'Renamed By Admin' })
      .expect(200);

    // The invalidation worked: generation 1 has never heard of the old snapshot.
    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(1);
    expect((await readProduct(slug)).body.name).toBe('Renamed By Admin');

    // Redis is now under memory pressure and drops the one key with no TTL to protect it.
    await evictTheGenerationCounter();

    // Generation 0 is addressable again, and its entries were never deleted — so the write is undone
    // as far as any reader can tell, while Postgres says otherwise.
    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(0);
    expect((await readProduct(slug)).body.name).toBe(name);
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: the single-flight lock keeps a herd on one cold key from becoming a herd on
  //   the database — that is the only reason it exists.
  // Violated at: src/shared/cache/swr-cache.service.ts:130-152 — a waiter polls for `waitMs` and
  //   then reads THROUGH, so the protection holds only while the rebuild finishes inside `waitMs`.
  //   The two budgets are configured independently (configuration.ts: CACHE_LOCK_WAIT_MS 500,
  //   CACHE_LOCK_LEASE_MS 5000), and nothing pairs them or the rebuild's real cost: any rebuild
  //   between them turns full suppression into none at all, with the herd arriving at Postgres
  //   staggered by `waitMs` instead of at once. `lock_timeout` counts it, and only after the fact.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — CACHE-2.
  it('lets the whole herd through to Postgres once the rebuild outlasts the waiter budget', async () => {
    await createTestProduct(app);
    const config = app.get(ConfigService);
    // The relationship under test, stated rather than assumed: waiters give up long before the
    // holder's lease does, so a rebuild between the two is unprotected.
    // Only the two config reads are assertions — they check what the app actually booted with.
    // Comparing SLOW_REBUILD_MS against the two literals would be arithmetic on constants declared
    // ten lines apart, which cannot fail and would say nothing if it did.
    expect(config.get('cache.waitMs')).toBe(LOCK_WAIT_MS);
    expect(config.get('cache.leaseMs')).toBe(LOCK_LEASE_MS);

    const original = source.findManyActive.bind(source);
    const reads = vi.spyOn(source, 'findManyActive').mockImplementation(async (criteria) => {
      await sleep(SLOW_REBUILD_MS);
      return original(criteria);
    });
    const timeoutsBefore = await readCacheCounter(app, 'lock_timeout');

    const responses = await Promise.all(
      Array.from({ length: HERD }, () => request(app.getHttpServer()).get('/products')),
    );

    for (const response of responses) expect(response.status).toBe(200);
    // One holder plus every waiter that gave up: the lock suppressed nothing.
    expect(reads).toHaveBeenCalledTimes(HERD);
    expect(await readCacheCounter(app, 'lock_timeout')).toBe(timeoutsBefore + HERD - 1);
  });
});
