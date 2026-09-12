import type { INestApplication } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalizeOrderUseCase, SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import {
  lapseReservation,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAppWithFakeGateway } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';

const WEBHOOK_SECRET = 'whsec_e2e_saga_observability_0123456789';
const STOCK = 10;
const QUANTITY = 2;
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };

/**
 * The effects themselves are proven elsewhere; this is about whether an operator watching only
 * `/metrics` and the log could tell a healthy checkout funnel from a stalled one, and one kind of
 * rollback from another. Trace continuity across the queue hop is outbox-queue-e2e's claim.
 */
describe('Saga observability (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let sweep: SweepExpiredReservationsUseCase;
  let finalize: FinalizeOrderUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    // Pinned rather than inherited from the developer's .env, so the guarded scrape behaves the same
    // on every machine.
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    sweep = app.get(SweepExpiredReservationsUseCase);
    finalize = app.get(FinalizeOrderUseCase);
  });

  // Explicit rather than `closeAppAfterAll`: the pinned token has to be cleared too.
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  async function scrape(): Promise<string> {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    return text;
  }

  /**
   * 0 when the series has not been touched yet. Counters accumulate for the life of the process and
   * `resetDatabase` cannot reach the registry, so every assertion below is a delta, not an absolute.
   */
  function sample(text: string, name: string, labels: Record<string, string> = {}): number {
    const pairs = Object.entries(labels);
    for (const line of text.split('\n')) {
      // Anchored on the delimiter that follows the name, so a future series this one is a prefix of
      // cannot be silently read as this one. Also what excludes the `# HELP`/`# TYPE` lines.
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (pairs.every(([key, value]) => line.includes(`${key}="${value}"`))) {
        return Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
    return 0;
  }

  async function lapsedOrder(): Promise<OpenOrder> {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapseReservation(app, order.orderId);
    return order;
  }

  const step = (text: string, name: string, outcome: string) =>
    sample(text, 'saga_step_total', { step: name, outcome });
  const compensation = (text: string, trigger: string) => sample(text, 'saga_compensation_total', { trigger });
  const expiries = (text: string) => sample(text, 'reservation_expiry_total');

  it('registers the three saga series, so a scrape describes them even at zero', async () => {
    const text = await scrape();

    for (const name of ['saga_step_total', 'saga_compensation_total', 'reservation_expiry_total']) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });

  it('counts the funnel forward: a hold, then the session opened against it', async () => {
    const before = await scrape();

    await placeAndOpenSession(app, sku, QUANTITY);

    const after = await scrape();
    expect(step(after, 'reserve', 'success')).toBe(step(before, 'reserve', 'success') + 1);
    expect(step(after, 'payment_session', 'success')).toBe(step(before, 'payment_session', 'success') + 1);
  });

  it('counts a paid order as a finalize step and never as a rollback', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_obs_paid')).expect(
      200,
    );

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success') + 1);
    expect(compensation(after, 'payment_failed')).toBe(compensation(before, 'payment_failed'));
    expect(compensation(after, 'ttl_expired')).toBe(compensation(before, 'ttl_expired'));
  });

  it('counts a failed payment as a compensation, attributed to the payment', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await postWebhook(
      app,
      signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'FAILED', 'evt_obs_failed'),
    ).expect(200);

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success') + 1);
    expect(compensation(after, 'payment_failed')).toBe(compensation(before, 'payment_failed') + 1);
    expect(compensation(after, 'ttl_expired')).toBe(compensation(before, 'ttl_expired'));
  });

  // The two expiry counters answer different questions, and this is the case where they move
  // together: the sweep itself claimed the order, so both the narrow counter and the rollback
  // counter see it.
  it('counts a swept expiry on both the sweep counter and the rollback counter', async () => {
    const { orderId } = await lapsedOrder();
    const before = await scrape();

    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ expired: 1 });

    const after = await scrape();
    expect(expiries(after)).toBe(expiries(before) + 1);
    expect(compensation(after, 'ttl_expired')).toBe(compensation(before, 'ttl_expired') + 1);
    expect(compensation(after, 'payment_failed')).toBe(compensation(before, 'payment_failed'));
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
  });

  it('counts nothing for a tick that swept an empty queue', async () => {
    const before = await scrape();

    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ scanned: 0 });

    const after = await scrape();
    expect(expiries(after)).toBe(expiries(before));
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success'));
  });

  // At-least-once delivery means the same settlement arrives more than once. A funnel that counted
  // every arrival would report a finalize rate set by the transport's retries, not by the shop.
  it('counts one step for a settlement applied twice', async () => {
    const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await expect(finalize.execute({ orderId, outcome: OrderStatus.PAID })).resolves.toMatchObject({
      status: 'finalized',
    });
    await expect(finalize.execute({ orderId, outcome: OrderStatus.PAID })).resolves.toMatchObject({ status: 'noop' });

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success') + 1);
  });

  it('counts nothing for an outcome that conflicts with a settled order', async () => {
    const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);
    await finalize.execute({ orderId, outcome: OrderStatus.PAID });
    const before = await scrape();

    await expect(finalize.execute({ orderId, outcome: OrderStatus.FAILED })).resolves.toMatchObject({
      status: 'ignored',
    });

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success'));
    expect(compensation(after, 'payment_failed')).toBe(compensation(before, 'payment_failed'));
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PAID);
  });

  // Labels are the one place an id is unrecoverable damage: Prometheus keeps a time series per
  // distinct combination, so one order id in a label is one series per order, forever.
  it('keeps the order id out of every saga label', async () => {
    const { orderId } = await lapsedOrder();
    await sweep.execute(SWEEP_ALL);

    const series = (await scrape()).split('\n').filter((line) => line.startsWith('saga_'));

    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      expect(line).not.toContain(orderId);
    }
  });

  // These assert what the call site hands the logger, not the serialized line. Two sets of fields
  // are deliberately absent from this object: the correlation fields, which pino's mixin adds at
  // serialization time, and `context`, which the transient logger merges in from setContext() after
  // this spy has already seen the arguments (the label itself is asserted in the unit spec).
  describe('the fields the saga puts on its settlement logs', () => {
    it('states the outcome and the audit reason against the order id', async () => {
      const info = vi.spyOn(PinoLogger.prototype, 'info');
      const { orderId } = await lapsedOrder();

      await sweep.execute(SWEEP_ALL);

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId,
          outcome: OrderStatus.EXPIRED,
          reason: 'ttl:expired',
        }),
        'order finalized',
      );
    });

    it('warns with both statuses when a late outcome is dropped, so the conflict is reconcilable', async () => {
      const warn = vi.spyOn(PinoLogger.prototype, 'warn');
      const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);
      await finalize.execute({ orderId, outcome: OrderStatus.PAID });

      await finalize.execute({ orderId, outcome: OrderStatus.FAILED });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId,
          current: OrderStatus.PAID,
          incoming: OrderStatus.FAILED,
        }),
        'conflicting finalize ignored',
      );
    });
  });
});
