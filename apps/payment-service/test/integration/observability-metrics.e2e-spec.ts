import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { referencedMetricNames } from '@jcool/testing/referenced-metric-names';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { metricsAuthHeader, scrapeMetrics } from '../setup/metrics.helper';

const INFRA = resolve(__dirname, '../../../../infra');
const UNCAPTURED_OLDEST = 'payment_authorized_uncaptured_oldest_seconds';

// Recorded by this service; the api and the inventory-service record some of them too, under their own job.
const OWNED = [
  'http_requests_total',
  'http_request_duration_seconds',
  'circuit_breaker_state',
  'circuit_breaker_calls_total',
  'tcc_branch_total',
  'outbox_backlog_pending',
  'outbox_oldest_age_seconds',
  'nodejs_eventloop_lag_seconds',
  'nodejs_heap_size_used_bytes',
  'nodejs_heap_size_total_bytes',
  UNCAPTURED_OLDEST,
];

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('answers 404 without the bearer token or with a wrong one', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader('wrong')).expect(404);
  });

  it('describes every metric it owns that the alert rules and dashboards query', async () => {
    const referenced = new Set(referencedMetricNames(INFRA));
    const owned = OWNED.filter((name) => referenced.has(name));

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    const described = new Set([...res.text.matchAll(/^# HELP (\S+)/gm)].map((match) => match[1]));
    expect(owned).toEqual(expect.arrayContaining(['http_requests_total', UNCAPTURED_OLDEST]));
    expect(owned.filter((name) => !described.has(name))).toEqual([]);
  });

  it('reports how long the oldest authorization has waited for its capture', async () => {
    await db.insert(schema.paymentOrders).values({
      orderId: testId(),
      status: 'AUTHORIZED',
      amountMinor: 80_000,
      currency: 'VND',
      authorizedAt: new Date(Date.now() - 1_200_000),
    });

    const metrics = await scrapeMetrics(app);

    // The gauge reads the database clock, which can sit a few milliseconds off this process's.
    expect(metrics.value(UNCAPTURED_OLDEST)).toBeCloseTo(1_200, -1);
  });
});
