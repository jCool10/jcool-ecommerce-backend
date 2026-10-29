import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referencedMetricNames } from '@jcool/testing/referenced-metric-names';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';

const INFRA = resolve(__dirname, '../../../../infra');
// Scraped from Prometheus itself, Loki and the id-service, not from the api.
const NOT_THE_API = /^(up|loki_\w+|id_clock_\w+)$/;
// Recorded only by the inventory-service or the payment-service, each checking them on its own /metrics.
const OWNED_ELSEWHERE = new Set<string>(['payment_authorized_uncaptured_oldest_seconds']);

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    app = await createTestApp();
  });

  // Clears the token so the next file in this worker boots with /metrics unguarded.
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('answers 404 without the bearer token or with a wrong one', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer wrong').expect(404);
  });

  it('describes every api metric the alert rules and dashboards query', async () => {
    const referenced = referencedMetricNames(INFRA).filter(
      (name) => !NOT_THE_API.test(name) && !OWNED_ELSEWHERE.has(name),
    );

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    const described = new Set([...res.text.matchAll(/^# HELP (\S+)/gm)].map((match) => match[1]));
    expect(referenced).toContain('http_requests_total');
    expect(referenced.filter((name) => !described.has(name))).toEqual([]);
  });

  it('labels the RED metric with the route template, never the concrete id', async () => {
    const rawId = 'zzz-cardinality-probe-9f1c';
    await request(app.getHttpServer()).get(`/products/${rawId}`);

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(res.text).toContain('route="/products/:idOrSlug"');
    expect(res.text).not.toContain(rawId);
  });

  it('records the real success status on the request counter', async () => {
    await request(app.getHttpServer()).get('/products').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/products"[^}]*status_code="200"/);
  });
});
