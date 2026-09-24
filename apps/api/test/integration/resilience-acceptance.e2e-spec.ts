import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENT_GATEWAY_BREAKER } from '../../src/modules/payment/infrastructure/gateway/breaker-payment-gateway.adapter';
import { RedisService } from '@jcool/platform/redis';
import { DEFAULT_THROTTLER, ORDER_THROTTLE, USER_THROTTLER } from '@jcool/platform/throttler';
import { CircuitBreakerFactory } from '@jcool/platform/resilience';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import {
  buyerWithCart,
  checkout,
  openSession,
  readPayment,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';

// The open window has to outlast a checkout attempt plus a `/metrics` scrape, and a scrape queries
// Postgres for the outbox backlog, so a loaded runner cannot slip the trial call in early.
const BREAKER_RESET_MS = 5_000;
// Its own breaker, so tripping it leaves the payment circuit to the test that owns it.
const PROBE_BREAKER = 'resilience-acceptance-probe';

const IP_LIMIT = ORDER_THROTTLE[DEFAULT_THROTTLER].limit;
const USER_LIMIT = ORDER_THROTTLE[USER_THROTTLER].limit;

describe('Resilience acceptance: cache, limiter, and breaker in one app (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  // Throttler counters live in Redis and outlive the process, so a re-run could start mid-window.
  const resetThrottleCounters = () => app.get(RedisService).getClient().flushdb();

  beforeAll(async () => {
    // Rate limiting is off in the default harness; this suite is here precisely to run with it on.
    process.env.THROTTLE_ENABLED = 'true';
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Pinned rather than defaulted: a local .env could otherwise switch off the cache or the circuit.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      BREAKER_ENABLED: 'true',
      BREAKER_VOLUME_THRESHOLD: '2',
      BREAKER_ERROR_THRESHOLD_PCT: '50',
      BREAKER_RESET_TIMEOUT_MS: String(BREAKER_RESET_MS),
      // Wide enough that two failures cannot be split across windows by a GC pause.
      BREAKER_ROLLING_WINDOW_MS: '10000',
    }));
    await resetDatabase(pool);
    await resetThrottleCounters();
    await resetCatalogCache(app);
  });

  // Also clears the opt-in flags, or the next file in this worker boots with rate limiting on.
  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
    delete process.env.METRICS_TOKEN;
  });

  const server = () => app.getHttpServer();

  async function scrape(): Promise<string> {
    const res = await request(server()).get('/metrics').set(metricsAuthHeader()).expect(200);
    return res.text;
  }

  // Label order in the exposition follows the metric's declaration, so labels are matched by
  // lookahead. A missing series answers `undefined`, so a renamed metric fails instead of reading 0.
  function sampleOf(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
    const lookaheads = Object.entries(labels)
      .map(([key, value]) => `(?=[^}]*${key}="${value}")`)
      .join('');
    const body = lookaheads === '' ? '(?:\\{[^}]*\\})?' : `\\{${lookaheads}[^}]*\\}`;
    const match = new RegExp(`^${name}${body} ([0-9.e+-]+)`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  }

  // A counter's series only exists once it has been incremented, so an absent baseline is a real zero.
  function baselineOf(text: string, name: string, labels: Record<string, string> = {}): number {
    return sampleOf(text, name, labels) ?? 0;
  }

  function postOrder(token: string): request.Test {
    return request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).send();
  }

  it('fails a checkout fast while the payment circuit is open, then recovers', async () => {
    const sku = await seedSellableSku(app, { onHand: 3 });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;

    // Read before the circuit opens: everything up to the state assertions has to fit inside the
    // open window, and the two failures below count as `failure`, not `rejected`.
    const rejectionsBefore = baselineOf(await scrape(), 'circuit_breaker_calls_total', {
      breaker: PAYMENT_GATEWAY_BREAKER,
      result: 'rejected',
    });

    // The same name returns the breaker the payment module already built, so this trips the circuit
    // the buyer's own checkout runs through.
    const gateway = app.get(CircuitBreakerFactory).create(PAYMENT_GATEWAY_BREAKER);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(gateway.run(() => Promise.reject(new Error('gateway boom')))).rejects.toThrow('gateway boom');
    }

    await openSession(app, token, orderId).expect(502);

    const whileOpen = await scrape();
    expect(sampleOf(whileOpen, 'circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(2);
    expect(
      sampleOf(whileOpen, 'circuit_breaker_calls_total', { breaker: PAYMENT_GATEWAY_BREAKER, result: 'rejected' }),
    ).toBe(rejectionsBefore + 1);
    // A refused session must not strand the buyer with a PENDING payment no webhook will settle.
    expect(await readPayment(app, orderId)).toBeUndefined();

    await sleep(BREAKER_RESET_MS + 200);
    const recovered = await openSession(app, token, orderId).expect(201);

    expect(recovered.body.providerSessionId).toMatch(/^cs_test_/);
    expect(sampleOf(await scrape(), 'circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(0);
  });

  it('turns an account away at the IP tier while its own budget is untouched', async () => {
    // The per-user tier is pinned in rate-limit-sensitive-endpoints; this spends the shared address
    // budget, which any one account can exhaust for everyone.
    await resetThrottleCounters();
    const before = baselineOf(await scrape(), 'rate_limit_rejections_total', {
      tier: DEFAULT_THROTTLER,
      route: '/orders',
    });

    for (let spent = 0; spent < IP_LIMIT;) {
      const { accessToken } = await createTestPrincipal(app);
      for (let i = 0; i < Math.min(USER_LIMIT, IP_LIMIT - spent); i++, spent++) {
        // 400, not merely "not 429": a fresh buyer has an empty cart, so a broken auth or route
        // cannot spend the budget silently.
        expect((await postOrder(accessToken)).status).toBe(400);
      }
    }

    const newcomer = await createTestPrincipal(app);
    expect((await postOrder(newcomer.accessToken)).status).toBe(429);
    expect(sampleOf(await scrape(), 'rate_limit_rejections_total', { tier: DEFAULT_THROTTLER, route: '/orders' })).toBe(
      before + 1,
    );
  });

  it('reports cache, limiter and breaker activity on one scrape', async () => {
    await resetThrottleCounters();
    const before = await scrape();

    const { slug } = await createTestProduct(app);
    await request(server()).get(`/products/${slug}`).expect(200);

    const { accessToken } = await createTestPrincipal(app);
    for (let attempt = 0; attempt < USER_LIMIT; attempt++) {
      expect((await postOrder(accessToken)).status).toBe(400);
    }
    expect((await postOrder(accessToken)).status).toBe(429);

    const probe = app.get(CircuitBreakerFactory).create(PROBE_BREAKER);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(probe.run(() => Promise.reject(new Error('probe boom')))).rejects.toThrow('probe boom');
    }

    const after = await scrape();
    const limited = { tier: USER_THROTTLER, route: '/orders' };
    expect(sampleOf(after, 'catalog_cache_operations_total', { result: 'miss' })).toBeGreaterThan(
      baselineOf(before, 'catalog_cache_operations_total', { result: 'miss' }),
    );
    expect(sampleOf(after, 'cache_rebuild_duration_seconds_count')).toBeGreaterThan(
      baselineOf(before, 'cache_rebuild_duration_seconds_count'),
    );
    expect(sampleOf(after, 'rate_limit_rejections_total', limited)).toBe(
      baselineOf(before, 'rate_limit_rejections_total', limited) + 1,
    );
    expect(sampleOf(after, 'circuit_breaker_transitions_total', { breaker: PROBE_BREAKER, to: 'open' })).toBe(1);
    expect(sampleOf(after, 'circuit_breaker_state', { breaker: PROBE_BREAKER })).toBe(2);
  });
});
