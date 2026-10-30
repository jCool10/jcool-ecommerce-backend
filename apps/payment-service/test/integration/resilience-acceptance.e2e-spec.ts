import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isProviderUnavailable, paymentRoutes } from '@jcool/internal-contracts';
import { CircuitBreakerFactory } from '@jcool/platform/resilience';
import {
  PAYMENT_CAPTURE_BREAKER,
  PAYMENT_GATEWAY_BREAKER,
} from '../../src/modules/payment/infrastructure/gateway/breaker-payment-gateway.adapter';
import { readPayment } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithPool, internalPost, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { scrapeMetrics } from '../setup/metrics.helper';
import { sleep } from '../setup/sleep';

// The open window has to outlast a session attempt plus a `/metrics` scrape, and a scrape queries
// Postgres for the outbox backlog, so a loaded runner cannot slip the trial call in early.
const BREAKER_RESET_MS = 5_000;
const OPEN = 2;
const CLOSED = 0;

// The real Stripe adapter, offline for want of a key, so only the breakers decide the outcome.
describe('Resilience acceptance: cache, limiter, and breaker in one app (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    // Pinned rather than defaulted: a local .env could otherwise switch off the circuit.
    ({ app, pool } = await createTestAppWithPool({
      BREAKER_ENABLED: 'true',
      BREAKER_VOLUME_THRESHOLD: '2',
      BREAKER_ERROR_THRESHOLD_PCT: '50',
      BREAKER_RESET_TIMEOUT_MS: String(BREAKER_RESET_MS),
      // Wide enough that two failures cannot be split across windows by a GC pause.
      BREAKER_ROLLING_WINDOW_MS: '10000',
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const openSession = (orderId: string) =>
    internalPost(app, paymentRoutes.session(orderId)).send({
      amountMinor: 150_000,
      currency: 'VND',
      expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    });

  // The same name returns the breaker the payment module already built, so this trips the circuit
  // the api's own calls run through.
  async function trip(name: string): Promise<void> {
    const breaker = app.get(CircuitBreakerFactory).create(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(breaker.run(() => Promise.reject(new Error(`${name} boom`)))).rejects.toThrow('boom');
    }
  }

  // Ordered first: the capture circuit it leaves open must not be the one checkout depends on.
  it('keeps checkout open while only the capture circuit is open', async () => {
    await trip(PAYMENT_CAPTURE_BREAKER);

    const res = await openSession(testId()).expect(200);

    expect(res.body.providerSessionId).toMatch(/^cs_test_/);
    const metrics = await scrapeMetrics(app);
    expect(metrics.value('circuit_breaker_state', { breaker: PAYMENT_CAPTURE_BREAKER })).toBe(OPEN);
    expect(metrics.value('circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(CLOSED);
  });

  it('fails a checkout fast while the payment circuit is open, then recovers', async () => {
    const orderId = testId();
    // Read before the circuit opens: the two failures below count as `failure`, not `rejected`.
    const rejected = { breaker: PAYMENT_GATEWAY_BREAKER, result: 'rejected' };
    const rejectionsBefore = (await scrapeMetrics(app)).value('circuit_breaker_calls_total', rejected) ?? 0;
    await trip(PAYMENT_GATEWAY_BREAKER);

    const refused = await openSession(orderId).expect(503);

    expect(refused.headers['retry-after']).toBe('1');
    expect(isProviderUnavailable(refused.status, refused.body)).toBe(true);
    const whileOpen = await scrapeMetrics(app);
    expect(whileOpen.value('circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(OPEN);
    expect(whileOpen.value('circuit_breaker_calls_total', rejected)).toBe(rejectionsBefore + 1);
    // A refused session must not strand the buyer with a PENDING payment no webhook will settle.
    expect(await readPayment(app, orderId)).toBeUndefined();

    await sleep(BREAKER_RESET_MS + 200);
    const recovered = await openSession(orderId).expect(200);

    expect(recovered.body).toMatchObject({ outcome: 'OPENED', providerSessionId: expect.stringMatching(/^cs_test_/) });
    expect((await scrapeMetrics(app)).value('circuit_breaker_state', { breaker: PAYMENT_GATEWAY_BREAKER })).toBe(
      CLOSED,
    );
  });
});
