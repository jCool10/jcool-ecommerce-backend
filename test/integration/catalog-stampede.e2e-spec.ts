import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure/drizzle-product.repository';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { withRedisDown } from '../setup/redis-outage';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-catalog-stampede-token-abcdef';
const HERD = 20;
// Long enough that every member of the herd is already in flight before the winner answers.
const SOURCE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCacheCounter(app: INestApplication, result: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .get('/metrics')
    .set('Authorization', `Bearer ${METRICS_TOKEN}`)
    .expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

/**
 * The Drizzle adapter is the thing a herd would trample, so it is spied on directly: how many times
 * it ran is the single-flight guarantee, and slowing it is what lets a herd form at all.
 */
function slowDetailRead(source: DrizzleProductRepository) {
  const original = source.findActiveByIdOrSlug.bind(source);
  return vi.spyOn(source, 'findActiveByIdOrSlug').mockImplementation(async (idOrSlug) => {
    await sleep(SOURCE_DELAY_MS);
    return original(idOrSlug);
  });
}

function slowListRead(source: DrizzleProductRepository) {
  const original = source.findManyActive.bind(source);
  return vi.spyOn(source, 'findManyActive').mockImplementation(async (criteria) => {
    await sleep(SOURCE_DELAY_MS);
    return original(criteria);
  });
}

describe('Catalog stampede protection (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    // Pinned, not defaulted: a local .env would otherwise decide whether a waiter outlasts the
    // injected source delay, which is the whole assertion.
    app = await createTestApp({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: '2000',
    });
    pool = app.get<Pool>(PG_POOL);
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

  it('queries Postgres once for a herd landing on a cold product detail', async () => {
    const { slug } = await createTestProduct(app);
    const spy = slowDetailRead(source);
    const waitsBefore = await readCacheCounter(app, 'lock_wait');

    const responses = await Promise.all(
      Array.from({ length: HERD }, () => request(app.getHttpServer()).get(`/products/${slug}`)),
    );

    expect(responses.map((res) => res.status)).toEqual(Array.from({ length: HERD }, () => 200));
    expect(new Set(responses.map((res) => res.body.slug as string))).toEqual(new Set([slug]));
    expect(spy).toHaveBeenCalledTimes(1);
    // The losers waited for the winner's value instead of each opening their own query. Not an
    // equality: a straggler arriving after the winner's write is a plain fresh hit, never a wait.
    expect(await readCacheCounter(app, 'lock_wait')).toBeGreaterThanOrEqual(waitsBefore + 1);
  });

  it('queries Postgres once for a herd landing on a cold list page', async () => {
    await createTestProduct(app);
    const spy = slowListRead(source);

    const responses = await Promise.all(
      Array.from({ length: HERD }, () => request(app.getHttpServer()).get('/products')),
    );

    expect(responses.map((res) => res.status)).toEqual(Array.from({ length: HERD }, () => 200));
    expect(responses.every((res) => res.body.total === 1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps serving a herd from Postgres when the whole cache layer is unreachable', async () => {
    const { slug } = await createTestProduct(app);

    await withRedisDown(app, async () => {
      const responses = await Promise.all(
        Array.from({ length: HERD }, () => request(app.getHttpServer()).get(`/products/${slug}`)),
      );
      expect(responses.map((res) => res.status)).toEqual(Array.from({ length: HERD }, () => 200));
    });
  });
});

describe('Catalog stale-while-revalidate under load (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    // Shortest fresh window the env schema accepts, so the stale path is reachable in a test. The
    // stale window is pinned too: a local `CACHE_STALE_WINDOW_SEC=0` would delete the entry instead
    // of ageing it, and every assertion below would be about a miss.
    app = await createTestApp({
      CATALOG_CACHE_TTL_SEC: '1',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '0',
    });
    pool = app.get<Pool>(PG_POOL);
    source = app.get(DrizzleProductRepository);
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a whole herd from the stale entry while exactly one refresh runs behind it', async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
    const { slug } = await createTestProduct(app);

    const filled = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    await sleep(1_200);

    const staleBefore = await readCacheCounter(app, 'hit_stale');
    const spy = slowDetailRead(source);
    const responses = await Promise.all(
      Array.from({ length: HERD }, () => request(app.getHttpServer()).get(`/products/${slug}`)),
    );

    // Every one of them answered from the expired entry rather than queueing behind the refresh.
    expect(responses.every((res) => res.status === 200 && res.body.name === filled.body.name)).toBe(true);
    expect(await readCacheCounter(app, 'hit_stale')).toBe(staleBefore + HERD);

    // The refresh is fire-and-forget, so it has to be given time to land before it can be counted.
    await sleep(SOURCE_DELAY_MS * 3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
