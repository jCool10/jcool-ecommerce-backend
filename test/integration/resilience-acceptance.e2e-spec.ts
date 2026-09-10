import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrizzleProductRepository } from '@modules/catalog/infrastructure/drizzle-product.repository';
import { PAYMENT_GATEWAY_BREAKER } from '@modules/payment/infrastructure/gateway/breaker-payment-gateway.adapter';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '@shared/infrastructure/redis';
import { DEFAULT_THROTTLER, ORDER_THROTTLE, USER_THROTTLER } from '@shared/infrastructure/throttler';
import { CircuitBreakerFactory } from '@shared/resilience';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import {
  buyerWithCart,
  checkout,
  openSession,
  readPayment,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-resilience-acceptance-token-abcdef';
const HERD = 20;
// Long enough that the whole herd is in flight before the winner answers.
const SOURCE_DELAY_MS = 200;
// The open window has to outlast a checkout attempt plus a `/metrics` scrape, and a scrape queries
// Postgres for the outbox backlog. Tight enough to keep the suite quick, loose enough that a loaded
// runner cannot slip the trial call in ahead of the assertions that the circuit is still open.
const BREAKER_RESET_MS = 5_000;

const IP_LIMIT = ORDER_THROTTLE[DEFAULT_THROTTLER].limit;
const USER_LIMIT = ORDER_THROTTLE[USER_THROTTLER].limit;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Each mechanism is already pinned on its own (catalog-stampede, rate-limit-sensitive-endpoints,
 * circuit-breaker.factory.spec). What only a shared app can show is that they coexist: limiter and
 * single-flight lock on one Redis client and one request path, all three on one scrape.
 */
describe('Resilience acceptance: cache, limiter, and breaker in one app (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let source: DrizzleProductRepository;

  beforeAll(async () => {
    // Rate limiting is off in the default harness; this suite is here precisely to run with it on.
    process.env.THROTTLE_ENABLED = 'true';
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    app = await createTestApp({
      // Pinned rather than defaulted, including both kill-switches: a local .env decides otherwise
      // whether a waiter outlasts the injected source delay, whether the lease outlives the rebuild,
      // and whether there is a circuit at all — each of which is one of the assertions below.
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: '2000',
      CACHE_LOCK_LEASE_MS: '5000',
      BREAKER_ENABLED: 'true',
      BREAKER_VOLUME_THRESHOLD: '2',
      BREAKER_ERROR_THRESHOLD_PCT: '50',
      BREAKER_RESET_TIMEOUT_MS: String(BREAKER_RESET_MS),
      // Wide enough that the two failures below cannot be split across windows by a GC pause and
      // leave the circuit closed with nothing to show for them.
      BREAKER_ROLLING_WINDOW_MS: '10000',
    });
    pool = app.get<Pool>(PG_POOL);
    source = app.get(DrizzleProductRepository);
    await resetDatabase(pool);
    // Throttler counters live in Redis and outlive the process, so a re-run inside one window would
    // start partway through the IP budget the last test below depends on.
    await app.get(RedisService).getClient().flushdb();
    await resetCatalogCache(app);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
    delete process.env.METRICS_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const server = () => app.getHttpServer();

  async function scrape(): Promise<string> {
    const res = await request(server()).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`).expect(200);
    return res.text;
  }

  // Label order in the exposition follows the metric's declaration, not the call site, so labels are
  // matched by lookahead. A missing series answers `undefined`, never 0 — otherwise a renamed metric
  // or label would satisfy every assertion expecting a zero instead of failing one.
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

  it('rebuilds a hot key once for a herd the live limiter lets through', async () => {
    const { slug } = await createTestProduct(app);
    const original = source.findActiveByIdOrSlug.bind(source);
    const spy = vi.spyOn(source, 'findActiveByIdOrSlug').mockImplementation(async (idOrSlug) => {
      await sleep(SOURCE_DELAY_MS);
      return original(idOrSlug);
    });

    const responses = await Promise.all(Array.from({ length: HERD }, () => request(server()).get(`/products/${slug}`)));

    // Two Redis-backed mechanisms on one client and one request path: the limiter must not read a
    // legitimate herd as a flood, and the lock must still collapse it to a single query.
    expect(responses.map((res) => res.status)).toEqual(Array.from({ length: HERD }, () => 200));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sampleOf(await scrape(), 'catalog_cache_operations_total', { result: 'lock_wait' })).toBeGreaterThan(0);
  });

  it('fails a checkout fast while the payment circuit is open, then opens a session once it closes', async () => {
    const sku = await seedSellableSku(app, { onHand: 3 });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;

    // Read before the circuit opens, not after: everything from here to the state assertions has to
    // fit inside the open window, and a call the breaker refuses is the only thing that moves this
    // counter — the two failures below arrive as `failure`, so the baseline is the same either way.
    const rejectionsBefore = baselineOf(await scrape(), 'circuit_breaker_calls_total', {
      breaker: PAYMENT_GATEWAY_BREAKER,
      result: 'rejected',
    });

    // The same name returns the breaker the payment module already built, so this trips the circuit
    // the buyer's own checkout runs through — not a lookalike standing next to it.
    const gateway = app.get(CircuitBreakerFactory).create(PAYMENT_GATEWAY_BREAKER);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(gateway.run(() => Promise.reject(new Error('gateway boom')))).rejects.toThrow('gateway boom');
    }

    await openSession(app, token, orderId).expect(502);

    const whileOpen = await scrape();
    expect(sampleOf(whileOpen, 'circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(2);
    // Counted as `rejected`, never `failure`: the request cost the provider nothing, which is the
    // whole point of failing fast rather than holding a slot open for a dependency that is down.
    expect(
      sampleOf(whileOpen, 'circuit_breaker_calls_total', { breaker: PAYMENT_GATEWAY_BREAKER, result: 'rejected' }),
    ).toBe(rejectionsBefore + 1);
    // Nothing was persisted either, so the order is still payable — a refused session must not
    // strand a buyer with a PENDING payment row no webhook will ever settle.
    expect(await readPayment(app, orderId)).toBeUndefined();

    await sleep(BREAKER_RESET_MS + 200);
    const recovered = await openSession(app, token, orderId).expect(201);

    expect(recovered.body.providerSessionId).toMatch(/^cs_test_/);
    expect(sampleOf(await scrape(), 'circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(0);
  });

  it('turns an account away at the IP tier even while its own per-user budget is untouched', async () => {
    // The per-user tier is pinned in rate-limit-sensitive-endpoints; what this spends is the shared
    // address budget, which no account can see and any one of them can exhaust for everyone.
    await app.get(RedisService).getClient().flushdb();
    const before = baselineOf(await scrape(), 'rate_limit_rejections_total', {
      tier: DEFAULT_THROTTLER,
      route: '/orders',
    });

    for (let spent = 0; spent < IP_LIMIT;) {
      const { accessToken } = await createTestUser(app);
      for (let i = 0; i < Math.min(USER_LIMIT, IP_LIMIT - spent); i++, spent++) {
        // 400, not merely "not 429": a fresh buyer has an empty cart, and the guard increments the
        // address budget ahead of the handler — so a broken auth or route would spend the budget
        // just as silently and only surface as a confusing pass below.
        expect((await postOrder(accessToken)).status).toBe(400);
      }
    }

    const newcomer = await createTestUser(app);
    expect((await postOrder(newcomer.accessToken)).status).toBe(429);
    expect(sampleOf(await scrape(), 'rate_limit_rejections_total', { tier: DEFAULT_THROTTLER, route: '/orders' })).toBe(
      before + 1,
    );
  });

  it('reports cache, limiter, and breaker on the one scrape an on-call reads', async () => {
    const metrics = await scrape();

    // A mechanism that works and cannot be seen working is indistinguishable from one that is off:
    // every rule in infra/prometheus reads these three families, and this is where the wiring from
    // guard, cache, and breaker to the registry is proven end to end rather than per unit.
    expect(sampleOf(metrics, 'catalog_cache_operations_total', { result: 'miss' })).toBeGreaterThan(0);
    expect(sampleOf(metrics, 'cache_rebuild_duration_seconds_count')).toBeGreaterThan(0);
    expect(sampleOf(metrics, 'rate_limit_rejections_total', { tier: DEFAULT_THROTTLER })).toBeGreaterThan(0);
    const opened = sampleOf(metrics, 'circuit_breaker_transitions_total', {
      breaker: PAYMENT_GATEWAY_BREAKER,
      to: 'open',
    });
    expect(opened).toBeGreaterThan(0);
    // Back to closed: an acceptance run must not leave the gauge that pages someone stuck at open.
    expect(sampleOf(metrics, 'circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(0);
  });
});
