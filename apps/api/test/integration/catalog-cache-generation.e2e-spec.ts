import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_CACHE_VERSION_KEY } from '../../src/modules/catalog/infrastructure/catalog-cache.keys';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure/drizzle-product.repository';
import { CacheService } from '../../src/shared/cache';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '@jcool/platform/redis';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';
import { createTestApp } from '../setup/test-app.factory';

const HERD = 20;
// Between the waiter budget and the lease: every waiter gives up while the holder still works.
const SLOW_REBUILD_MS = 1_500;
const LOCK_WAIT_MS = 500;
const LOCK_LEASE_MS = 5_000;

async function readCacheCounter(app: INestApplication, result: string): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

describe('Catalog cache generation and lock budget (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let cache: CacheService;
  let redis: RedisService;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Pinned so a local .env cannot change the wait/lease relationship under test.
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

  const evictTheGenerationCounter = () => redis.getClient().del(CATALOG_CACHE_VERSION_KEY);

  const readProduct = (slug: string) => request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

  // Known defect. Intended: a snapshot an admin write invalidated is never served again.
  // Actual: CacheService.readCounter reads an evicted CATALOG_CACHE_VERSION_KEY as generation 0,
  // whose entries are still cached, so the write is undone for every reader until they expire.
  it('re-serves an invalidated snapshot after the generation counter is evicted', async () => {
    await evictTheGenerationCounter();
    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(0);

    const { productId, slug, name } = await createTestProduct(app);
    expect((await readProduct(slug)).body.name).toBe(name);

    const { accessToken } = await createTestAdminPrincipal(app);
    await request(app.getHttpServer())
      .patch(`/admin/products/${productId}`)
      .set(authHeader(accessToken))
      .send({ name: 'Renamed By Admin' })
      .expect(200);

    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(1);
    expect((await readProduct(slug)).body.name).toBe('Renamed By Admin');

    await evictTheGenerationCounter();

    expect(await cache.readCounter(CATALOG_CACHE_VERSION_KEY)).toBe(0);
    expect((await readProduct(slug)).body.name).toBe(name);
  });

  // Known defect. Intended: the single-flight lock keeps a herd on one cold key off the database.
  // Actual: SwrCacheService.waitForEnvelope gives up after CACHE_LOCK_WAIT_MS and reads through,
  // and nothing pairs that budget with the lease, so a slower rebuild protects nothing.
  it('lets the whole herd through once the rebuild outlasts the waiter budget', async () => {
    await createTestProduct(app);
    const config = app.get(ConfigService);
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
    expect(reads).toHaveBeenCalledTimes(HERD);
    expect(await readCacheCounter(app, 'lock_timeout')).toBe(timeoutsBefore + HERD - 1);
  });
});
