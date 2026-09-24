import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure/drizzle-product.repository';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';

const HERD = 20;
// Long enough that the whole herd is in flight before the winner answers.
const SOURCE_DELAY_MS = 200;

async function readCacheCounter(app: INestApplication, result: string): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

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
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Pinned so a waiter always outlasts the injected source delay.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: '2000',
    }));
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
    // At least one: a straggler arriving after the winner's write is a plain hit, not a wait.
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
});

describe('Catalog stale-while-revalidate under load (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // A 1s fresh window with a wide stale window, so an entry ages into stale instead of expiring.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '1',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '0',
    }));
    source = app.get(DrizzleProductRepository);
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a whole herd from the stale entry while one refresh runs behind it', async () => {
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

    expect(responses.every((res) => res.status === 200 && res.body.name === filled.body.name)).toBe(true);
    expect(await readCacheCounter(app, 'hit_stale')).toBe(staleBefore + HERD);

    await sleep(SOURCE_DELAY_MS * 3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
