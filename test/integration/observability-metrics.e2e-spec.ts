import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../setup/test-app.factory';

// Metrics pillar over the real HTTP stack: the guarded /metrics endpoint (Phase 2 DoD-14) and
// the RED route-template label (DoD-6 cardinality rule). METRICS_TOKEN is set before the app
// builds so the ConfigModule factory picks it up (mirrors how the factory reads container URLs).
const METRICS_TOKEN = 'e2e-metrics-token-abcdef';

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    app = await createTestApp();
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('returns 404 without the bearer token (never confirms the endpoint exists)', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });

  it('returns 404 with a wrong token', async () => {
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer wrong').expect(404);
  });

  it('exposes default + RED + business metrics with the correct token (DoD-14, DoD-6)', async () => {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    const body = res.text;
    // Default (saturation): event-loop lag proves collectDefaultMetrics ran.
    expect(body).toContain('nodejs_eventloop_lag_seconds');
    // RED.
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('http_requests_total');
    // ≥5 business metrics (HELP/TYPE present even before first observation).
    expect(body).toContain('orders_created_total');
    expect(body).toContain('order_value_minor');
    expect(body).toContain('cart_operations_total');
    expect(body).toContain('catalog_cache_operations_total');
    expect(body).toContain('auth_events_total');
    // Messaging + the outbox gauges. Presence only: the gauges now read the table on every scrape,
    // and this app shares its database with whatever suite ran before it — asserting a value here
    // would make this file fail for another file's leftovers. What the numbers mean is
    // outbox-queue-e2e's subject, on a database it resets itself.
    expect(body).toContain('messaging_publish_total');
    expect(body).toContain('messaging_consume_total');
    expect(body).toContain('outbox_backlog_pending');
    expect(body).toContain('outbox_oldest_age_seconds');
  });

  it('labels the RED metric with the route TEMPLATE, never the concrete id (cardinality)', async () => {
    // A param route with a distinctive raw id: the request runs through the handler, so the
    // interceptor records it. The label must be the template — the raw id must NOT appear.
    const rawId = 'zzz-cardinality-probe-9f1c';
    await request(app.getHttpServer()).get(`/products/${rawId}`);

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    expect(res.text).toContain('route="/products/:idOrSlug"');
    expect(res.text).not.toContain(rawId);
  });

  it('records the real success status on the counter (200 on the products list)', async () => {
    // Locks in that the interceptor reads the final response status on the success path
    // (this stack sets res.statusCode before the tap fires).
    await request(app.getHttpServer()).get('/products').expect(200);

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/products"[^}]*status_code="200"/);
  });
});
