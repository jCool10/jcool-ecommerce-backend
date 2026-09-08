import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { FinalizeOrderUseCase, SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import {
  placeAndOpenSession,
  postWebhook,
  readOrder,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Pinned rather than inherited from the developer's .env, so the guarded scrape behaves the same on
// every machine.
const METRICS_TOKEN = 'e2e-saga-observability-token';
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
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sweep: SweepExpiredReservationsUseCase;
  let finalize: FinalizeOrderUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    sweep = app.get(SweepExpiredReservationsUseCase);
    finalize = app.get(FinalizeOrderUseCase);
  });

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
    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
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

  async function lapse(orderId: string): Promise<void> {
    await db
      .update(schema.reservations)
      .set({ expiresAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(schema.reservations.orderId, orderId));
  }

  async function lapsedOrder(): Promise<OpenOrder> {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapse(order.orderId);
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

  // These assert what the call site hands the logger, not the serialized line — the correlation
  // fields come from pino's mixin at serialization time and are never part of this object.
  describe('the fields the saga puts on its settlement logs', () => {
    it('states the outcome and the audit reason against the order id', async () => {
      const info = vi.spyOn(PinoLogger.prototype, 'info');
      const { orderId } = await lapsedOrder();

      await sweep.execute(SWEEP_ALL);

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'FinalizeOrder',
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
          context: 'FinalizeOrder',
          orderId,
          current: OrderStatus.PAID,
          incoming: OrderStatus.FAILED,
        }),
        'conflicting finalize ignored',
      );
    });
  });
});
