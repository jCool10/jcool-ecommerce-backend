import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleProductRepository } from '../../src/modules/product/infrastructure/catalog/drizzle-product.repository';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';

const MAX_IN_FLIGHT = 2;
const HERD = 6;
// Long enough that the whole herd arrives while the admitted requests are still in flight.
const SOURCE_DELAY_MS = 300;

function slowListRead(source: DrizzleProductRepository) {
  const original = source.findManyActive.bind(source);
  return vi.spyOn(source, 'findManyActive').mockImplementation(async (criteria) => {
    await sleep(SOURCE_DELAY_MS);
    return original(criteria);
  });
}

async function readShedCount(app: INestApplication): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const match = /^http_requests_shed_total\{method="GET"\} (\d+)/m.exec(res.text);
  return match ? Number(match[1]) : 0;
}

describe('Load shedding (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    ({ app, pool } = await createTestAppWithPool({
      HTTP_MAX_IN_FLIGHT: String(MAX_IN_FLIGHT),
      HTTP_SHED_RETRY_AFTER_SEC: '3',
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
    await createTestProduct(app);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers the excess 503 with Retry-After while the limit is in flight, then serves again', async () => {
    slowListRead(source);
    const shedBefore = await readShedCount(app);

    const responses = await Promise.all(
      Array.from({ length: HERD }, () => request(app.getHttpServer()).get('/products')),
    );

    const shed = responses.filter((res) => res.status === 503);
    expect(responses.filter((res) => res.status === 200)).toHaveLength(MAX_IN_FLIGHT);
    expect(shed).toHaveLength(HERD - MAX_IN_FLIGHT);
    expect(shed.every((res) => res.headers['retry-after'] === '3')).toBe(true);
    expect(shed[0]?.body).toMatchObject({ statusCode: 503, path: '/products' });
    expect(await readShedCount(app)).toBe(shedBefore + HERD - MAX_IN_FLIGHT);

    await request(app.getHttpServer()).get('/products').expect(200);
  });

  it('keeps answering health and metrics probes while the limit is in flight', async () => {
    slowListRead(source);
    const inFlight = Promise.all(
      Array.from({ length: MAX_IN_FLIGHT }, () => request(app.getHttpServer()).get('/products')),
    );
    await sleep(SOURCE_DELAY_MS / 3);

    await request(app.getHttpServer()).get('/products').expect(503);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    const metrics = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    expect(metrics.text).toMatch(new RegExp(`^http_requests_in_flight ${MAX_IN_FLIGHT}$`, 'm'));

    expect((await inFlight).map((res) => res.status)).toEqual([200, 200]);
  });
});
