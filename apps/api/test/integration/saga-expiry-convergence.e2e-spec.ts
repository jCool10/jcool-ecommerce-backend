import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Job, Queue } from 'bullmq';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases/reconcile-stale-orders.use-case';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DeadLetterJob } from '../../src/shared/messaging/queue/dead-letter';
import { DOMAIN_EVENTS_DLQ_QUEUE, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import {
  lapseReservation,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readReservation,
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

// Only reconcile closes the checkout session before it ends an order, so the reservation sweep is
// meant to reach an order after reconcile has had its chance.
describe('Saga expiry convergence between the two sweeps (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let sweep: SweepExpiredReservationsUseCase;
  let reconcile: ReconcileStaleOrdersUseCase;
  let relay: OutboxRelay;
  let queue: Queue;
  let dlq: Queue;
  let metrics: MetricsPort;
  let sku: SellableSku;

  // A cadence the boot assert should refuse. Once it does, this boot fails and takes both tests down.
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
        // Reconcile ticks once an hour on orders that expire after fifteen minutes.
        RECONCILE_INTERVAL_MS: ONE_HOUR_MS,
        ORDER_TTL_SEC: String(ORDER_TTL_SEC),
        QUEUE_WORKER_ENABLED: 'true',
        QUEUE_CONSUMER_ATTEMPTS: ATTEMPTS,
        QUEUE_CONSUMER_BACKOFF_MS: '50',
      },
      [{ provide: PAYMENT_GATEWAY, useValue: gateway }],
    );
    pool = app.get<Pool>(PG_POOL);
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

  async function lapsedOrder(): Promise<OpenOrder> {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapseReservation(app, order.orderId);
    return order;
  }

  const deadLetters = async (eventType: string): Promise<Job<DeadLetterJob>[]> => {
    const jobs = (await dlq.getJobs(['waiting', 'prioritized'])) as Job<DeadLetterJob>[];
    return jobs.filter((job) => job.data.eventType === eventType);
  };

  // Stock is sellable again while the hosted page still takes money.
  async function expectStockBackWhileSessionStaysOpen(order: OpenOrder): Promise<void> {
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect((await readReservation(app, order.orderId)).status).toBe('RELEASED');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
    expect(gateway.wasExpired(order.sessionId)).toBe(false);
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
  }

  async function payTheOpenSession(order: OpenOrder, eventId: string): Promise<void> {
    const refundOwed = vi.spyOn(metrics, 'recordRefundOwed');

    await postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', eventId)).expect(200);

    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    // The order is terminal, so the finalize is ignored and the money has nothing to attach to.
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect(refundOwed).toHaveBeenCalledWith('webhook_direct');
  }

  // Known defect. Intended: an enabled sweep only reaches orders reconcile has already had a chance
  // to close. Actual: ReservationTtlScheduler.assertBehindReconcile compares TTL thresholds only and
  // never reads whether reconcile is enabled, how often it ticks or how much its batch drains.
  it('starts the sweep behind a reconcile that cannot reach an order first', async () => {
    const config = app.get(ConfigService);
    // The inputs the assert weighs, which it accepted: 900s of hold plus 900s of grace.
    expect(config.get('inventory.reservationTtl')).toBe('15m');
    expect(config.get('reservationSweep.graceSec')).toBe(ORDER_TTL_SEC);
    expect(config.get('reconcile.orderTtlSec')).toBe(ORDER_TTL_SEC);
    // The input it never reads: reconcile runs four times less often than orders expire.
    expect(config.get('reconcile.intervalMs')).toBe(Number(ONE_HOUR_MS));
    expect(app.get(SchedulerRegistry).doesExist('interval', INTERVAL_NAME)).toBe(true);

    const order = await lapsedOrder();

    // The expiry event is not relayed: the session close is a separate hop, so every expiry passes
    // through this window.
    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ scanned: 1, expired: 1 });

    await expectStockBackWhileSessionStaysOpen(order);
    await payTheOpenSession(order, 'evt_saga_cadence_paid');

    // Reconcile only reads PENDING orders, so it can no longer repair this one.
    expect(await reconcile.execute({ staleAfterSec: 0, ttlSec: ORDER_TTL_SEC, batchSize: 50 })).toMatchObject({
      scanned: 0,
      finalized: 0,
    });
  });

  // Known defect. Intended: releasing the hold and closing the session are one outcome, so a session
  // that cannot be closed keeps the stock held. Actual: SweepExpiredReservationsUseCase commits the
  // release with only an order.expired outbox row to carry the close; once the consumer's retry
  // budget is spent the message is dead-lettered and nothing re-derives the owed close.
  it('leaves a payable session on released stock once the expiry dead-letters', async () => {
    const order = await lapsedOrder();
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

    // The outbox row is marked published, so the dead letter is the only record the close is owed.
    await expect(relay.runOnce(50)).resolves.toMatchObject({ published: 0, failed: 0 });
    await expectStockBackWhileSessionStaysOpen(order);

    await payTheOpenSession(order, 'evt_saga_dlq_paid');
  });
});
