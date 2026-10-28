import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
} from '../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../src/modules/order/application/ports/order-repository.port';
import { OrderItem } from '../../src/modules/order/domain/order-item.entity';
import { Order } from '../../src/modules/order/domain/order.entity';
import { CheckoutReservingReaperScheduler } from '../../src/modules/order/interface/checkout-reserving-reaper.scheduler';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_QUEUE, ORDER_PAID_BACKOFF } from '../../src/shared/messaging/queue/queue.constants';
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import {
  holdCalls,
  orderEventTypes,
  relayAuthorization,
  sagaHandle,
  sagaWorker,
} from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder } from '../setup/fixtures/inventory.fixture';
import {
  addToCart,
  auditLedgerInvariants,
  authorizeSession,
  buyerWithCart,
  checkout,
  openSession,
  readOrder,
  readStock,
  reservationsFor,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { testId } from '../setup/id-service-stub';
import { sleep } from '../setup/sleep';
import { UNREACHABLE_TEMPORAL_ADDRESS } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_temporal_0001';
const RESERVE_WAIT_MS = 4000;
const CANCEL_WAIT_MS = 3000;
const ORPHAN_SEC = 5;
// Every wait a few seconds, inside every cross rule.
const SAGA_ENV = {
  CHECKOUT_TRY_TIMEOUT_MS: '2000',
  CHECKOUT_RESERVE_WAIT_MS: String(RESERVE_WAIT_MS),
  CHECKOUT_CANCEL_WAIT_MS: String(CANCEL_WAIT_MS),
  CHECKOUT_RESERVING_ORPHAN_SEC: String(ORPHAN_SEC),
  SAGA_RETRY_BASE_MS: '100',
  SAGA_RETRY_CAP_MS: '500',
};

describe('Checkout saga and Temporal (integration, real Temporal dev server, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  const extraApps: INestApplication[] = [];

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app, ...extraApps],
    () => pool,
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const engine = (on: INestApplication = app) => on.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);

  async function placed(on: INestApplication = app) {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const token = await buyerWithCart(on, sku.variantId);
    const orderId = (await checkout(on, token).expect(201)).body.id as string;
    return { sku, token, orderId };
  }

  async function paid(on: INestApplication = app) {
    const order = await placed(on);
    const pay = await openSession(on, order.token, order.orderId).expect(201);
    const intentId = await authorizeSession(on, pay.body.providerSessionId as string, order.orderId);
    return { ...order, intentId };
  }

  /** An order tx A wrote whose saga never started, as a crash between the two would leave it. */
  async function orphan(placedAgoMs: number) {
    const placedAt = new Date(Date.now() - placedAgoMs);
    const order = Order.create(testId(), 'VND', [OrderItem.of(testId(), 'Widget', 50_000, 1)]).reserve(
      placedAt,
      new Date(placedAt.getTime() + 60 * 60_000),
    );
    const { order: saved } = await app
      .get<OrderRepositoryPort>(ORDER_REPOSITORY)
      .createReserving({ order, idempotencyKey: null });
    return saved.id as string;
  }

  it('hands an orphaned RESERVING order back to its saga, which rejects it', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { user, accessToken } = await createTestPrincipal(app);
    await addToCart(app, accessToken, sku.variantId);
    vi.spyOn(engine(), 'reserve').mockRejectedValueOnce(new CheckoutEngineUnavailableError());
    await checkout(app, accessToken).expect(503);
    const [stranded] = await db.select().from(schema.orders).where(eq(schema.orders.userId, user.id));
    expect(stranded.status).toBe('RESERVING');

    await sleep(ORPHAN_SEC * 1000 + 200);
    await app.get(CheckoutReservingReaperScheduler).tick();

    await untilOrderStatus(app, stranded.id, 'REJECTED');
    expect(await sagaHandle(app, stranded.id).result()).toBe('COMPENSATED');
    expect((await readReservationOrder(app, stranded.id))?.status).toBe('FENCED');
    expect(await reservationsFor(app, stranded.id)).toEqual([]);
    expect((await auditLedgerInvariants(app)).violations).toEqual([]);
  });

  it('leaves an order alone that is younger than the orphan threshold', async () => {
    const orderId = await orphan(0);

    await app.get(CheckoutReservingReaperScheduler).tick();

    expect((await readOrder(app, orderId)).status).toBe('RESERVING');
    await expect(sagaHandle(app, orderId).describe()).rejects.toThrow();
  });

  it('keeps an authorization through engine outages, delivering it once Temporal answers', async () => {
    const { sku, orderId, intentId } = await paid();
    vi.spyOn(engine(), 'notifyAuthorized')
      .mockRejectedValueOnce(new CheckoutEngineUnavailableError())
      .mockRejectedValueOnce(new CheckoutEngineUnavailableError());

    await expect(relayAuthorization(app, orderId)).rejects.toThrow();
    await expect(relayAuthorization(app, orderId)).rejects.toThrow();
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 5 })).violations).toEqual([]);
  });

  it('queues payment.authorized on the long ladder', async () => {
    const { orderId } = await paid();

    await app.get(OutboxRelay).runOnce(100);

    const jobs = await app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE).getJobs(['waiting', 'prioritized']);
    const job = jobs.find((j) => j.data.eventType === 'payment.authorized' && j.data.payload.orderId === orderId);
    expect(job?.opts).toMatchObject({
      attempts: app.get(ConfigService).getOrThrow<number>('queue.orderPaidAttempts'),
      backoff: { type: ORDER_PAID_BACKOFF },
    });
  });

  it('captures once for an authorization delivered twice', async () => {
    const { sku, orderId, intentId } = await paid();
    const queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
    await app.get(OutboxRelay).runOnce(100);
    const [job] = (await queue.getJobs(['waiting', 'prioritized'])).filter(
      (j) => j.data.eventType === 'payment.authorized',
    );
    // A redelivery after the job was acknowledged: BullMQ may hand it out again, the inbox dedups it.
    await queue.add(job.data.eventType, job.data, { jobId: `${job.id}-redelivered` });

    expect(await relayAuthorization(app, orderId)).toBe(2);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await orderEventTypes(app, orderId)).toEqual(['order.placed', 'order.paid']);
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 5 })).violations).toEqual([]);
  });

  it('voids an authorization that lands while the saga is compensating a cancel', async () => {
    const { sku, token, orderId } = await placed();
    const pay = await openSession(app, token, orderId).expect(201);
    const paymentCancel = holdCalls(app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT), 'cancel');
    await request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(authHeader(token)).expect(200);

    const intentId = await authorizeSession(app, pay.body.providerSessionId as string, orderId);
    await relayAuthorization(app, orderId);
    paymentCancel.release();

    await eventually(
      () => gateway.wasVoided(intentId),
      (voided) => voided,
    );
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect((await readOrder(app, orderId)).status).toBe('CANCELLED');
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 5 })).violations).toEqual([]);
  });

  describe('Temporal unreachable', () => {
    let deadApp: INestApplication;

    beforeAll(async () => {
      ({ app: deadApp } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
        ...SAGA_ENV,
        TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL_ADDRESS,
        TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('unreachable'),
        TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: '500',
        TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: '500',
      }));
    });
    afterAll(async () => {
      await deadApp?.close();
    });

    it('stops a reaper tick at the first order the engine cannot take', async () => {
      const orphans = [await orphan(60_000), await orphan(60_000), await orphan(60_000)];
      const ensureStarted = vi.spyOn(engine(deadApp), 'ensureStarted');

      await deadApp.get(CheckoutReservingReaperScheduler).tick();

      expect(ensureStarted).toHaveBeenCalledTimes(1);
      for (const orderId of orphans) expect((await readOrder(app, orderId)).status).toBe('RESERVING');
    });

    it('answers checkout and cancel with 503 in their wait, holds no stock, and keeps serving the rest', async () => {
      const { orderId, token } = await placed();
      const sku = await seedSellableSku(app, { onHand: 5 });
      const buyer = await buyerWithCart(deadApp, sku.variantId);
      const server = deadApp.getHttpServer();

      let startedAt = Date.now();
      const refused = await request(server).post('/orders').set(authHeader(buyer)).set(idempotencyKeyHeader());
      expect(refused.status).toBe(503);
      expect(refused.headers['retry-after']).toBe('5');
      expect(Date.now() - startedAt).toBeLessThan(RESERVE_WAIT_MS + 1000);
      expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);

      startedAt = Date.now();
      const cancel = await request(server).post(`/orders/${orderId}/cancel`).set(authHeader(token));
      expect(cancel.status).toBe(503);
      expect(cancel.headers['retry-after']).toBe('5');
      expect(Date.now() - startedAt).toBeLessThan(CANCEL_WAIT_MS + 1000);
      expect((await readOrder(app, orderId)).status).toBe('PENDING');

      await request(server).get('/products').expect(200);
      await request(server).get('/cart').set(authHeader(buyer)).expect(200);
      await request(server).get('/health/ready').expect(200);
      expect(['CONNECTING', 'BACKOFF']).toContain(sagaWorker(deadApp).status().state);
    });
  });

  describe('two apps polling one task queue', () => {
    let second: INestApplication;

    beforeAll(async () => {
      // The same fake gateway, so an activity sees one provider whichever app runs it.
      ({ app: second } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV, [], { gateway }));
      extraApps.push(second);
    });
    afterAll(async () => {
      extraApps.splice(extraApps.indexOf(second), 1);
      await second?.close();
    });

    it('gives every saga exactly one set of effects', async () => {
      const orders = await Promise.all([paid(app), paid(second), paid(app), paid(second)]);

      for (const [index, { orderId }] of orders.entries()) {
        await relayAuthorization(index % 2 === 0 ? second : app, orderId);
      }

      for (const { orderId, intentId } of orders) {
        await untilOrderStatus(app, orderId, 'PAID');
        expect(gateway.captureCalls(intentId)).toBe(1);
        expect(await orderEventTypes(app, orderId)).toEqual(['order.placed', 'order.paid']);
      }
      expect((await auditLedgerInvariants(app)).violations).toEqual([]);
    });
  });
});
