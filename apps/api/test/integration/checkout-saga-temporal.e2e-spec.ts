import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
} from '../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  INVENTORY_TCC,
  type InventoryTccPort,
} from '../../src/modules/order/application/ports/inventory-participant.port';
import { CheckoutReservingReaperScheduler } from '../../src/modules/order/interface/checkout-reserving-reaper.scheduler';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { deliverDomainEventsOnce, drainDomainEvents } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  buyerWithCart,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readPayment,
  readReservationOrder,
  readSagaState,
  readStock,
  sagaStepAttribute,
  seedSellableSku,
  waitForSagaClosed,
  waitForSagaState,
} from '../setup/fixtures/order-flow.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  createTestAppWithPool,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_temporal_01';
const RESERVE_WAIT_MS = 3_000;
const ORPHAN_SEC = 4;
const SHORT_SAGA = {
  CHECKOUT_TRY_TIMEOUT_MS: '1000',
  INVENTORY_TRY_LOCK_TIMEOUT_MS: '500',
  CHECKOUT_RESERVE_WAIT_MS: String(RESERVE_WAIT_MS),
  CHECKOUT_RESERVING_ORPHAN_SEC: String(ORPHAN_SEC),
  CHECKOUT_CANCEL_WAIT_MS: '2000',
  SAGA_RETRY_BASE_MS: '200',
  SAGA_RETRY_CAP_MS: '2000',
};

describe('Checkout saga on Temporal (integration, real Temporal dev server)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SHORT_SAGA));
    db = app.get<DrizzleDB>(DRIZZLE);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Another app over the same database, Redis keyspace and gateway double. */
  const secondApp = (env: Record<string, string> = {}) =>
    createTestAppWithPool({ ...SHORT_SAGA, PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);

  const postCheckout = (target: INestApplication, token: string, key: string) =>
    request(target.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));

  const orderByKey = async (key: string) => {
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.idempotencyKey, key));
    return row;
  };

  const outboxRows = (eventType: string, orderId: string) =>
    db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.eventType, eventType), eq(schema.outbox.aggregateId, orderId)));

  it('lets the reaper settle a reserving order whose saga never started, without running the Try', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const token = await buyerWithCart(app, sku.variantId, 2);
    const key = randomUUID();
    const engine = app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);
    vi.spyOn(engine, 'reserve').mockRejectedValueOnce(new CheckoutEngineUnavailableError('reserve'));
    const tryReserve = vi.spyOn(app.get<InventoryTccPort>(INVENTORY_TCC), 'tryReserve');

    const refused = await postCheckout(app, token, key).expect(503);

    expect(refused.headers['retry-after']).toBe(String(RESERVE_WAIT_MS / 1000));
    const orphan = await orderByKey(key);
    expect(orphan.status).toBe('RESERVING');
    expect(await sagaStepAttribute(app, orphan.id)).toBeNull();

    await sleep(orphan.placedAt!.getTime() + ORPHAN_SEC * 1000 + 200 - Date.now());
    await app.get(CheckoutReservingReaperScheduler).tick();
    await waitForSagaClosed(app, orphan.id);

    const rejected = await readOrder(app, orphan.id);
    expect(rejected).toMatchObject({ status: 'REJECTED', idempotencyKey: null });
    expect(rejected.finalizedAt).toBeInstanceOf(Date);
    expect((await readReservationOrder(app, orphan.id)).status).toBe('FENCED');
    expect(await sagaStepAttribute(app, orphan.id)).toBe('COMPENSATED');
    expect(tryReserve).not.toHaveBeenCalled();
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 5, quantityReserved: 0 });
  });

  it('keeps serving while Temporal is unreachable, and a healthy app finishes the stranded work', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const pending = await placeAndOpenSession(app, sku);
    const down = await secondApp({ TEMPORAL_ADDRESS: '127.0.0.1:1', TEMPORAL_WORKER_ENABLED: 'false' });
    try {
      await request(down.app.getHttpServer()).get('/products').expect(200);
      const ready = await request(down.app.getHttpServer()).get('/health/ready').expect(503);
      expect(ready.body.error).toMatchObject({ temporal: { status: 'down' } });

      const token = await buyerWithCart(app, sku.variantId);
      const key = randomUUID();
      // Times the engine alone: the rest of the request is database work that a loaded run slows down.
      const engine = down.app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);
      const reserve = engine.reserve.bind(engine);
      let reserveMs = 0;
      vi.spyOn(engine, 'reserve').mockImplementation(async (start) => {
        const startedAt = Date.now();
        try {
          return await reserve(start);
        } finally {
          reserveMs = Date.now() - startedAt;
        }
      });
      const refused = await postCheckout(down.app, token, key).expect(503);
      expect(reserveMs).toBeLessThan(RESERVE_WAIT_MS + 1_000);
      expect(refused.headers['retry-after']).toBe(String(RESERVE_WAIT_MS / 1000));
      const stranded = await orderByKey(key);
      expect(stranded.status).toBe('RESERVING');

      const cancel = await request(down.app.getHttpServer())
        .post(`/orders/${pending.orderId}/cancel`)
        .set(authHeader(pending.token))
        .expect(503);
      expect(cancel.headers['retry-after']).toBe('2');

      const intentId = gateway.authorize(pending.sessionId);
      await postAuthorizationWebhook(down.app, gateway, pending);
      await expect(deliverDomainEventsOnce(down.app)).rejects.toThrow(/payment\.authorized/);
      const claims = await db.select().from(schema.inbox).where(eq(schema.inbox.eventType, 'payment.authorized'));
      expect(claims).toHaveLength(0);

      await drainDomainEvents(app);
      expect((await readOrder(app, pending.orderId)).status).toBe('PAID');
      expect(gateway.captureCalls(intentId)).toBe(1);

      // Past its Try budget by now, so the rejoined saga gives the order up and frees the key.
      const healed = await postCheckout(app, token, key).expect(503);
      expect(healed.headers['retry-after']).toBe(String(RESERVE_WAIT_MS / 1000));
      expect((await readOrder(app, stranded.id)).status).toBe('REJECTED');
      expect((await readReservationOrder(app, stranded.id)).status).toBe('FENCED');

      const placed = await postCheckout(app, token, key).expect(201);
      expect(placed.body.id).not.toBe(stranded.id);
      expect(placed.body.status).toBe('PENDING');
    } finally {
      await down.app.close();
    }
  });

  it('applies an authorization delivered more than once exactly once', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const order = await placeAndOpenSession(app, sku, 2);
    const intentId = gateway.authorize(order.sessionId);
    await postAuthorizationWebhook(app, gateway, order);
    const payment = await readPayment(app, order.orderId);
    const authorization = {
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      authorizedAt: new Date(),
    };
    const engine = app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);

    await Promise.all([
      engine.notifyAuthorized(order.orderId, authorization),
      engine.notifyAuthorized(order.orderId, authorization),
    ]);
    await drainDomainEvents(app);

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(await sagaStepAttribute(app, order.orderId)).toBe('COMPLETED');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await outboxRows('order.paid', order.orderId)).toHaveLength(1);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 3, quantityReserved: 0 });
    await expect(auditLedgerInvariants(app, { [sku.variantId]: 5 })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });

  it('voids an authorization that arrives while the cancel compensation is still retrying', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const order = await placeAndOpenSession(app, sku);
    gateway.failExpireSession(order.sessionId);

    await request(app.getHttpServer()).post(`/orders/${order.orderId}/cancel`).set(authHeader(order.token)).expect(200);
    const stuck = await waitForSagaState(
      app,
      order.orderId,
      ({ step, pendingCompensations }) => step === 'COMPENSATING' && !pendingCompensations.includes('RELEASE_STOCK'),
    );
    expect(stuck.pendingCompensations).toEqual(['CANCEL_PAYMENT']);

    const intentId = gateway.authorize(order.sessionId);
    const payment = await readPayment(app, order.orderId);
    await app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE).notifyAuthorized(order.orderId, {
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      authorizedAt: new Date(),
    });
    expect((await readSagaState(app, order.orderId)).pendingCompensations).toEqual(['CANCEL_PAYMENT']);

    gateway.restoreExpireSession(order.sessionId);
    const closed = await waitForSagaClosed(app, order.orderId);

    expect(closed.status.name).toBe('COMPLETED');
    expect(await sagaStepAttribute(app, order.orderId)).toBe('COMPENSATED');
    expect((await readOrder(app, order.orderId)).status).toBe('CANCELLED');
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect((await readReservationOrder(app, order.orderId)).status).toBe('RELEASED');
  });

  it('runs each saga once when two workers poll the same task queue', async () => {
    const sku = await seedSellableSku(app, { onHand: 10 });
    const other = await secondApp();
    try {
      const orders = [];
      for (let i = 0; i < 4; i += 1) {
        orders.push(await placeAndOpenSession(i % 2 === 0 ? app : other.app, sku));
      }
      const intents = orders.map((order) => gateway.authorize(order.sessionId));
      for (const order of orders) await postAuthorizationWebhook(app, gateway, order);

      await drainDomainEvents(app);

      for (const [i, order] of orders.entries()) {
        expect((await readOrder(app, order.orderId)).status).toBe('PAID');
        expect(gateway.captureCalls(intents[i])).toBe(1);
        expect(await outboxRows('order.paid', order.orderId)).toHaveLength(1);
      }
      expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 6, quantityReserved: 0 });
      await expect(auditLedgerInvariants(app, { [sku.variantId]: 10 })).resolves.toEqual({
        orders: 4,
        pending: [],
        violations: [],
      });
    } finally {
      await other.app.close();
    }
  });
});
