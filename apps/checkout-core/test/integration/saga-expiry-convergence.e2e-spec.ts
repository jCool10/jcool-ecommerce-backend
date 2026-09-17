import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases/reconcile-stale-orders.use-case';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DeadLetterJob } from '../../src/shared/messaging/queue/dead-letter';
import { DOMAIN_EVENTS_DLQ_QUEUE, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { METRICS, type MetricsPort } from '../../src/shared/observability/metrics/metrics.port';
import {
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readStock,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_saga_expiry_secret_0123456789';
const STOCK = 10;
const QUANTITY = 2;
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };
// Both timers are registered but parked an hour out, so every tick in this file is one a test asked
// for and the schedulers are still the real ones that validated the config at boot.
const ONE_HOUR_MS = '3600000';
const ORDER_TTL_SEC = 900;
// Two deliveries, 50ms apart, so a whole budget is spent inside a test rather than over 15 seconds.
const ATTEMPTS = '2';

const INTERVAL_NAME = 'order-reservation-ttl-sweep';

/**
 * The reservation sweep and the gateway-driven reconcile both end an order nobody paid for, but only
 * reconcile can close the checkout session first — so the two are supposed to run in that order.
 * This file boots the pair in configurations the boot assert accepts and asks whether the ordering
 * it claims actually holds.
 */
describe('Saga expiry convergence between the two sweeps (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sweep: SweepExpiredReservationsUseCase;
  let reconcile: ReconcileStaleOrdersUseCase;
  let relay: OutboxRelay;
  let queue: Queue;
  let dlq: Queue;
  let metrics: MetricsPort;
  let sku: SellableSku;

  // When SAGA-1 lands, this boot is what fails: the fix makes the app refuse a reconcile interval
  // that cannot run before the reservation TTL, and these settings are deliberately that pair. The
  // failure therefore takes the whole file down, including the SAGA-2 test below, which is unrelated
  // to it — two red tests, one cause. That is the loud discrimination this file is for, not a
  // regression to chase.
  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp(
      {
        PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
        RESERVATION_SWEEP_ENABLED: 'true',
        RESERVATION_SWEEP_INTERVAL_MS: ONE_HOUR_MS,
        RESERVATION_SWEEP_GRACE_SEC: String(ORDER_TTL_SEC),
        INVENTORY_RESERVATION_TTL: '15m',
        RECONCILE_ENABLED: 'true',
        // The cadence: reconcile ticks once an hour on orders that expire after fifteen minutes.
        RECONCILE_INTERVAL_MS: ONE_HOUR_MS,
        ORDER_TTL_SEC: String(ORDER_TTL_SEC),
        QUEUE_WORKER_ENABLED: 'true',
        QUEUE_CONSUMER_ATTEMPTS: ATTEMPTS,
        QUEUE_CONSUMER_BACKOFF_MS: '50',
      },
      [{ provide: PAYMENT_GATEWAY, useValue: gateway }],
    );
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    sweep = app.get(SweepExpiredReservationsUseCase);
    reconcile = app.get(ReconcileStaleOrdersUseCase);
    relay = app.get(OutboxRelay);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    dlq = app.get<Queue>(DOMAIN_EVENTS_DLQ_QUEUE);
    metrics = app.get<MetricsPort>(METRICS);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    await dlq.obliterate({ force: true });
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Ages the hold by writing `expires_at`, so nothing here waits on a clock. */
  async function lapsedOrder(minutesAgo = 30): Promise<OpenOrder> {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await db
      .update(schema.reservations)
      .set({ expiresAt: new Date(Date.now() - minutesAgo * 60_000) })
      .where(eq(schema.reservations.orderId, order.orderId));
    return order;
  }

  const readReservation = async (orderId: string) =>
    (await db.select().from(schema.reservations).where(eq(schema.reservations.orderId, orderId)))[0];

  const deadLetters = async (eventType: string): Promise<Job<DeadLetterJob>[]> => {
    const jobs = (await dlq.getJobs(['waiting', 'prioritized'])) as Job<DeadLetterJob>[];
    return jobs.filter((job) => job.data.eventType === eventType);
  };

  /** The state that makes the window matter: stock is sellable again, the page still takes money. */
  async function expectStockBackWhileSessionStaysOpen(order: OpenOrder): Promise<void> {
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect((await readReservation(order.orderId)).status).toBe('RELEASED');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
    expect(gateway.wasExpired(order.sessionId)).toBe(false);
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
  }

  /** Pays the still-open session and reads back what that money bought: nothing. */
  async function payTheOpenSession(order: OpenOrder, eventId: string): Promise<void> {
    const refundOwed = vi.spyOn(metrics, 'recordRefundOwed');

    await postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', eventId)).expect(200);

    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    // The order is terminal, so the finalize is ignored and the money has nothing to attach to.
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect(refundOwed).toHaveBeenCalledWith('webhook_direct');
  }

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: when the reservation sweep is enabled, reconcile has genuinely already had a
  //   chance at every order the sweep will expire — because only reconcile closes the checkout
  //   session before releasing the hold (reconcile-stale-orders.use-case.ts:124-126 states that
  //   ordering as a requirement).
  // Violated at: src/modules/order/interface/reservation-ttl.scheduler.ts:109 — `assertBehindReconcile`
  //   compares THRESHOLDS only (`holdTtlSec + graceSec < orderTtlSec`). It never reads
  //   `reconcile.enabled`, `reconcile.intervalMs` or `reconcile.batchSize`, so a reconcile that is
  //   off, ticking slower than the TTL it guards, or permanently saturated by an oldest-first batch
  //   passes the assert unchanged — and the sweep starts anyway, reaching orders first.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — SAGA-1 (and matrix q2: whether
  //   the assert should also cover cadence and batch drain, or whether cadence belongs in a separate
  //   readiness check).
  it('starts the sweep behind a reconcile that cannot reach an order before it, and the boot assert says nothing', async () => {
    const config = app.get(ConfigService);
    // Exactly the inputs the assert weighs — and it accepted them: 900s of hold + 900s of grace is
    // not less than the 900s order TTL.
    expect(config.get('inventory.reservationTtl')).toBe('15m');
    expect(config.get('reservationSweep.graceSec')).toBe(ORDER_TTL_SEC);
    expect(config.get('reconcile.orderTtlSec')).toBe(ORDER_TTL_SEC);
    // ...and the input it never looks at: reconcile runs four times less often than orders expire.
    expect(config.get('reconcile.intervalMs')).toBe(Number(ONE_HOUR_MS));
    expect(app.get(SchedulerRegistry).doesExist('interval', INTERVAL_NAME)).toBe(true);

    const order = await lapsedOrder();

    // The tick the sweep's own timer would run. Its expiry event is emitted to the outbox but not
    // relayed here on purpose: the close is a separate hop by construction, so this is the window
    // every expiry passes through, not a stall invented by the test.
    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ scanned: 1, expired: 1 });

    await expectStockBackWhileSessionStaysOpen(order);
    await payTheOpenSession(order, 'evt_saga_cadence_paid');

    // And reconcile can no longer repair any of it: its queue is orders still PENDING, and the sweep
    // already took this one terminal. The next tick, an hour away, will not even see it.
    expect(await reconcile.execute({ staleAfterSec: 0, ttlSec: ORDER_TTL_SEC, batchSize: 50 })).toMatchObject({
      scanned: 0,
      finalized: 0,
    });
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a released stock hold and a closed checkout session are one outcome, so a
  //   session that cannot be closed keeps the stock held rather than leaving a payable page behind.
  // Violated at: src/modules/order/application/use-cases/sweep-expired-reservations.use-case.ts —
  //   the release commits with only an `order.expired` outbox row to carry the close, and the
  //   consumer's retry budget is finite: src/shared/messaging/queue/queue.constants.ts:35-47 caps it
  //   at `QUEUE_CONSUMER_ATTEMPTS`, after which src/shared/messaging/queue/dead-letter.ts:63 parks
  //   the message on a queue with no worker. Nothing re-derives the owed close from the EXPIRED
  //   order, so the session stays payable until a human replays the DLQ.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — SAGA-2.
  it('leaves a payable session on released stock when the expiry event exhausts its retry budget', async () => {
    const order = await lapsedOrder();
    // A gateway that refuses this one session for as long as the budget lasts — an outage, a revoked
    // key, a session the account no longer owns.
    gateway.failExpireSession(order.sessionId);

    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ scanned: 1, expired: 1 });
    await relay.runOnce(50);

    const [dead] = await vi.waitFor(
      async () => {
        const jobs = await deadLetters('order.expired');
        expect(jobs).toHaveLength(1);
        return jobs;
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(dead.data.attemptsMade).toBe(Number(ATTEMPTS));

    // The outbox row is marked published, so nothing will ever emit this event again: the dead-letter
    // entry is the only remaining record that a session is still owed a close.
    await expect(relay.runOnce(50)).resolves.toMatchObject({ published: 0, failed: 0 });
    await expectStockBackWhileSessionStaysOpen(order);

    await payTheOpenSession(order, 'evt_saga_dlq_paid');
  });
});
