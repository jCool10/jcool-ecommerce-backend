import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { referencedMetricNames } from '@jcool/testing/referenced-metric-names';
import { authHeader } from '../setup/bearer.helper';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';

const INFRA = resolve(__dirname, '../../../../infra');

// What the saga and the checker alert on; only this service records them.
const SAGA_ALERTED = [
  'checkout_saga_overdue',
  'checkout_saga_closed_abnormally',
  'checkout_saga_task_queue_pollers',
  'checkout_saga_task_queue_backlog_age_seconds',
  'checkout_saga_engine_up',
  'checkout_invariant_violations',
  'checkout_invariant_check_total',
  'saga_step_total',
  'saga_compensation_total',
];

// Recorded by this service; the api and the participants record some of them too, under their own job.
const OWNED = [
  'http_requests_total',
  'http_request_duration_seconds',
  'circuit_breaker_state',
  'circuit_breaker_calls_total',
  'rate_limit_rejections_total',
  'outbox_backlog_pending',
  'outbox_oldest_age_seconds',
  'messaging_dlq_total',
  'messaging_queue_oldest_waiting_seconds',
  'nodejs_eventloop_lag_seconds',
  'nodejs_heap_size_used_bytes',
  'nodejs_heap_size_total_bytes',
  'orders_created_total',
  'order_value_minor',
  'checkout_sagas_open',
  ...SAGA_ALERTED,
];

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestAppWithPool({ METRICS_TOKEN: E2E_METRICS_TOKEN }));
  });
  closeAppAfterAll(() => app);

  const scrape = () => request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

  it('answers 404 without the bearer token or with a wrong one', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader('wrong')).expect(404);
  });

  it('describes every metric it owns that the alert rules and dashboards query', async () => {
    const referenced = new Set(referencedMetricNames(INFRA));
    const owned = OWNED.filter((name) => referenced.has(name));

    const res = await scrape();

    const described = new Set([...res.text.matchAll(/^# HELP (\S+)/gm)].map((match) => match[1]));
    expect(owned).toEqual(expect.arrayContaining(['http_requests_total', ...SAGA_ALERTED]));
    expect(owned.filter((name) => !described.has(name))).toEqual([]);
  });

  it('labels the RED metric with the route template, never the concrete id', async () => {
    const rawId = 'zzz-cardinality-probe-9f1c';
    const token = await newPrincipalToken(app);
    await request(app.getHttpServer()).get(`/orders/${rawId}`).set(authHeader(token)).expect(400);

    const res = await scrape();

    expect(res.text).toContain('route="/orders/:id"');
    expect(res.text).not.toContain(rawId);
  });

  it('records the real success status on the request counter', async () => {
    const token = await newPrincipalToken(app);
    await request(app.getHttpServer()).get('/orders').set(authHeader(token)).expect(200);

    const res = await scrape();

    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/orders"[^}]*status_code="200"/);
  });
});
