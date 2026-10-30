import type { INestApplication } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { eq } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CheckoutCancelRejectedError,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
} from '../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../src/modules/order/application/ports/order-inventory-participant.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../src/modules/order/application/ports/order-repository.port';
import type { PaymentAuthorization } from '../../src/modules/order/domain/checkout-saga';
import { OrderItem } from '../../src/modules/order/domain/order-item.entity';
import { Order } from '../../src/modules/order/domain/order.entity';
import { checkoutWorkflowId, stateQuery } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { TEMPORAL_CLIENT } from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import {
  checkoutSagaStartOf,
  holdCalls,
  relayAuthorizationDirect,
  sagaEngine,
  sagaWorker,
} from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import { readOrder, readPaymentOrder, readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';
import { sleep } from '../setup/sleep';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

const PRICE = 50_000;
const CURRENCY = 'VND';
const DEADLINE_MS = 60 * 60_000;
// Production defaults, so the Try budget and the reserve wait are the ones the cases measure against.
const TRY_TIMEOUT_MS = 3000;
const RESERVE_WAIT_MS = 6000;
const SAGA_ENV = { TEMPORAL_WORKER_ENABLED: 'true', SAGA_RETRY_BASE_MS: '100', SAGA_RETRY_CAP_MS: '1000' };
// Every wait in seconds, inside every cross rule (the same set checkout-saga.env.spec.ts accepts).
const SHORT_DEADLINE_ENV = {
  CHECKOUT_PAYMENT_DEADLINE_SEC: '6',
  CHECKOUT_PAY_CUTOFF_SEC: '2',
  CHECKOUT_HOLD_SAFETY_SEC: '10',
  CHECKOUT_TRY_TIMEOUT_MS: '1000',
  CHECKOUT_RESERVE_WAIT_MS: '3000',
  CHECKOUT_CANCEL_WAIT_MS: '3000',
  CHECKOUT_RESERVING_ORPHAN_SEC: '4',
  INVENTORY_COMMAND_TIMEOUT_MS: '2000',
  SAGA_AUTH_GRACE_SEC: '1',
  SAGA_ACTIVITY_TIMEOUT_MS: '8000',
  PAYMENT_COMMAND_TIMEOUT_MS: '2000',
};

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms; last value ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

const workerRunning = (app: INestApplication) =>
  eventually(
    () => Promise.resolve(sagaWorker(app).status().state),
    (state) => state === 'RUNNING',
    30_000,
  );

describe('Checkout saga engine (integration, real Temporal dev server, real participants, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let paymentService: PaymentServiceStub;
  let inventoryService: InventoryServiceStub;
  // Apps a nested describe opens next to the main one; the reset drains their workers too.
  const extraApps: INestApplication[] = [];

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(SAGA_ENV));
    paymentService = await paymentServiceStub();
    inventoryService = await inventoryServiceStub();
    await workerRunning(app);
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app, ...extraApps],
    () => pool,
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const orders = () => app.get<OrderRepositoryPort>(ORDER_REPOSITORY);
  const inventory = () => app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT);
  const payment = () => app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT);
  const saga = (orderId: string) => app.get<Client>(TEMPORAL_CLIENT).workflow.getHandle(checkoutWorkflowId(orderId));

  async function placeReserving(
    options: { onHand?: number; placedAgoMs?: number; deadlineMs?: number; idempotencyKey?: string } = {},
  ) {
    const variantId = testId();
    await seedStock(app, variantId, options.onHand ?? 5);
    const placedAt = new Date(Date.now() - (options.placedAgoMs ?? 0));
    const order = Order.create(testId(), CURRENCY, [OrderItem.of(variantId, 'Widget', PRICE, 1)]).reserve(
      placedAt,
      new Date(placedAt.getTime() + (options.deadlineMs ?? DEADLINE_MS)),
    );
    const { order: saved } = await orders().createReserving({ order, idempotencyKey: options.idempotencyKey ?? null });
    return { orderId: saved.id as string, variantId, start: checkoutSagaStartOf(saved) };
  }

  async function placeHeld(onApp: INestApplication = app) {
    const placed = await placeReserving();
    await expect(sagaEngine(onApp).reserve(placed.start)).resolves.toBe('HELD');
    return placed;
  }

  async function openSession(orderId: string) {
    const session = await payment().openSession({
      orderId,
      amountMinor: PRICE,
      currency: CURRENCY,
      expiresAt: new Date(Date.now() + DEADLINE_MS),
    });
    if (session.outcome !== 'OPENED') throw new Error(`expected an open session for ${orderId}`);
    return session;
  }

  async function payThroughSaga(orderId: string, relayVia: INestApplication = app) {
    const session = await openSession(orderId);
    await paymentService.authorize(orderId);
    await relayAuthorizationDirect(relayVia, orderId);
    return { paymentId: session.paymentId };
  }

  const orderStatus = async (orderId: string) => (await readOrder(app, orderId))?.status;
  const untilOrderIs = (orderId: string, status: string, timeoutMs?: number) =>
    eventually(
      () => orderStatus(orderId),
      (current) => current === status,
      timeoutMs,
    );
  const orderEvents = async (orderId: string) =>
    (
      await db
        .select({ eventType: schema.outbox.eventType })
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, orderId))
    ).map(({ eventType }) => eventType);
  const reservedOf = async (variantId: string) => (await readStock(app, variantId))?.quantityReserved;

  /** Waits until the run has nothing scheduled; a query after that reflects every result so far. */
  const untilQuiet = (orderId: string) =>
    eventually(
      async () => (await saga(orderId).describe()).raw.pendingActivities?.length ?? 0,
      (pending) => pending === 0,
    );

  it('holds stock on reserve and leaves the saga waiting for the payment', async () => {
    const { orderId } = await placeHeld();

    expect(await orderStatus(orderId)).toBe('PENDING');
    expect((await readReservationOrder(app, orderId))?.status).toBe('HELD');
    expect(await orderEvents(orderId)).toEqual(['order.placed']);
    expect((await saga(orderId).query(stateQuery)).step).toBe('AWAITING_AUTH');
  });

  it('rejects an order it cannot stock and frees its idempotency key', async () => {
    const { orderId, variantId, start } = await placeReserving({ onHand: 0, idempotencyKey: 'key-out-of-stock' });

    await expect(sagaEngine(app).reserve(start)).resolves.toBe('OUT_OF_STOCK');

    const row = await readOrder(app, orderId);
    expect(row).toMatchObject({ status: 'REJECTED', finalizedAt: expect.any(Date), idempotencyKey: null });
    expect(await saga(orderId).result()).toBe('COMPENSATED');
    expect(await reservedOf(variantId)).toBe(0);
  });

  it('answers TIMEOUT within the Try budget when the inventory-service hangs, and fences the late Try', async () => {
    // Most of the budget already spent, so the activity's deadline ends the Try before the adapter's own.
    const { orderId, variantId, start } = await placeReserving({ placedAgoMs: 1500 });
    const hung = inventoryService.hang('try');

    const startedAt = Date.now();
    await expect(sagaEngine(app).reserve(start)).resolves.toBe('TIMEOUT');
    await hung.reached;
    expect(Date.now() - startedAt).toBeLessThan(TRY_TIMEOUT_MS + 1000);
    expect(await orderStatus(orderId)).toBe('REJECTED');
    // The hung Try never lands, so the release fences an order with no hold.
    expect(await saga(orderId).result()).toBe('COMPENSATED');

    expect((await readReservationOrder(app, orderId))?.status).toBe('FENCED');
    await expect(
      inventory().tryReserve({ orderId, lines: start.lines, holdUntil: new Date(Date.now() + DEADLINE_MS) }),
    ).resolves.toBe('CONFLICT');
    expect(await reservedOf(variantId)).toBe(0);
  });

  // The hold is the inventory-service's, so a starved pool here only delays writing the result down.
  it('keeps the hold while the pool is exhausted, and places the order once it frees up', async () => {
    const { orderId, variantId, start } = await placeReserving();
    // Every client the app's pool can hand out, whatever DB_POOL_MAX this run booted with.
    const poolMax = (pool as Pool & { options: { max: number } }).options.max;
    const clients: PoolClient[] = await Promise.all(Array.from({ length: poolMax }, () => pool.connect()));

    const startedAt = Date.now();
    let answer: unknown;
    try {
      answer = await sagaEngine(app)
        .reserve(start)
        .catch((error: unknown) => error);
    } finally {
      for (const client of clients) client.release();
    }

    expect(Date.now() - startedAt).toBeLessThan(RESERVE_WAIT_MS + 1000);
    if (answer !== 'HELD') expect(answer).toBeInstanceOf(CheckoutEngineUnavailableError);
    await untilOrderIs(orderId, 'PENDING');
    expect(await reservedOf(variantId)).toBe(1);
  });

  it('keeps reserving while slow captures fill every regular activity slot', async () => {
    const capture = holdCalls(payment(), 'capture');
    const [first, second] = [await placeHeld(), await placeHeld()];
    await payThroughSaga(first.orderId);
    await payThroughSaga(second.orderId);
    await capture.waitForCalls(2);

    const third = await placeReserving();
    const startedAt = Date.now();
    await expect(sagaEngine(app).reserve(third.start)).resolves.toBe('HELD');
    expect(Date.now() - startedAt).toBeLessThan(TRY_TIMEOUT_MS);

    capture.release();
    await untilOrderIs(first.orderId, 'PAID');
    await untilOrderIs(second.orderId, 'PAID');
  });

  it('settles a paid order end to end: stock committed, money captured, one order.paid', async () => {
    const { orderId } = await placeHeld();

    const { paymentId } = await payThroughSaga(orderId);

    await untilOrderIs(orderId, 'PAID');
    expect(await readOrder(app, orderId)).toMatchObject({ paymentRef: paymentId });
    expect((await readReservationOrder(app, orderId))?.status).toBe('COMMITTED');
    expect((await readPaymentOrder(app, orderId))?.status).toBe('CAPTURED');
    expect(await orderEvents(orderId)).toEqual(['order.placed', 'order.paid']);
    expect(paymentService.providerCaptures(orderId)).toBe(1);
    expect(await saga(orderId).result()).toBe('COMPLETED');
  });

  it('ignores authorizations payment cannot vouch for, then completes on the real one', async () => {
    const { orderId, start } = await placeHeld();
    const commit = vi.spyOn(inventory(), 'commit');
    const statusOf = vi.spyOn(payment(), 'statusOf');
    const session = await openSession(orderId);
    const late = { ...start, mode: 'lateAuthorization' as const };
    const signal = (overrides: Partial<PaymentAuthorization> = {}) =>
      sagaEngine(app).notifyAuthorized(late, {
        paymentId: session.paymentId,
        amountMinor: PRICE,
        currency: CURRENCY,
        authorizedAt: new Date().toISOString(),
        ...overrides,
      });

    const verified = (count: number) =>
      eventually(
        () => Promise.resolve(statusOf.mock.settledResults.filter(({ type }) => type !== 'incomplete').length),
        (settled) => settled >= count,
      );

    await signal(); // the session is still OPEN: nothing is authorized yet
    await signal({ amountMinor: PRICE - 1 }); // never reaches verification
    // Before the authorization, or the first check could already read the header as AUTHORIZED.
    await verified(1);
    await paymentService.authorize(orderId);
    await signal({ paymentId: testId() }); // authorized, but not by this payment
    await verified(2);
    await untilQuiet(orderId);

    expect(statusOf).toHaveBeenCalledTimes(2);
    expect((await saga(orderId).query(stateQuery)).step).toBe('AWAITING_AUTH');
    expect(await orderStatus(orderId)).toBe('PENDING');
    expect((await readReservationOrder(app, orderId))?.status).toBe('HELD');
    expect(commit).not.toHaveBeenCalled();

    await relayAuthorizationDirect(app, orderId);
    await untilOrderIs(orderId, 'PAID');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('cancels a waiting order with stock already back by the time cancel returns', async () => {
    const { orderId, variantId } = await placeHeld();
    expect(await reservedOf(variantId)).toBe(1);

    await sagaEngine(app).cancel(orderId, 'buyer');

    expect(await readOrder(app, orderId)).toMatchObject({ status: 'CANCELLED', finalizeReason: 'user:cancel' });
    expect(await reservedOf(variantId)).toBe(0);
    expect(['CANCELLED', 'FENCED']).toContain((await readPaymentOrder(app, orderId))?.status);
  });

  it('refuses to cancel once stock is being committed, and still completes', async () => {
    const commit = holdCalls(inventory(), 'commit');
    const { orderId } = await placeHeld();
    await payThroughSaga(orderId);
    await commit.waitForCalls(1);

    const failure = await sagaEngine(app)
      .cancel(orderId, 'buyer')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CheckoutCancelRejectedError);
    expect(failure).toMatchObject({ orderId, step: 'COMMITTING_STOCK' });
    commit.release();
    await untilOrderIs(orderId, 'PAID');
  });

  it('reports a closed saga to a cancel that comes after the run ended', async () => {
    const { orderId, start } = await placeReserving({ onHand: 0 });
    await expect(sagaEngine(app).reserve(start)).resolves.toBe('OUT_OF_STOCK');
    await saga(orderId).result();

    await expect(sagaEngine(app).cancel(orderId, 'buyer')).rejects.toBeInstanceOf(CheckoutSagaClosedError);
  });

  describe('authorization after the run closed', () => {
    const authorization = (paymentId: string): PaymentAuthorization => ({
      paymentId,
      amountMinor: PRICE,
      currency: CURRENCY,
      authorizedAt: new Date().toISOString(),
    });

    it('voids it in a late-authorization run and leaves a cancelled order alone', async () => {
      const { orderId, start } = await placeHeld();
      const session = await openSession(orderId);
      await sagaEngine(app).cancel(orderId, 'buyer');
      await saga(orderId).result();
      const cancel = vi.spyOn(payment(), 'cancel');

      await sagaEngine(app).notifyAuthorized({ ...start, mode: 'lateAuthorization' }, authorization(session.paymentId));

      expect(await saga(orderId).result()).toBe('COMPENSATED');
      expect(cancel).toHaveBeenCalledWith(orderId, expect.anything());
      expect(await readOrder(app, orderId)).toMatchObject({ status: 'CANCELLED', finalizeReason: 'user:cancel' });
    });

    it('does nothing for an order already paid', async () => {
      const { orderId, start } = await placeHeld();
      const { paymentId } = await payThroughSaga(orderId);
      await untilOrderIs(orderId, 'PAID');
      await saga(orderId).result();
      const cancel = vi.spyOn(payment(), 'cancel');

      await sagaEngine(app).notifyAuthorized({ ...start, mode: 'lateAuthorization' }, authorization(paymentId));

      expect(await saga(orderId).result()).toBe('COMPLETED');
      expect(cancel).not.toHaveBeenCalled();
      expect(await orderStatus(orderId)).toBe('PAID');
    });
  });

  describe('ensureStarted', () => {
    it('rejects an orphaned RESERVING order whose Try budget is long gone', async () => {
      const { orderId, start } = await placeReserving({ placedAgoMs: 60_000 });

      await sagaEngine(app).ensureStarted(start);

      expect(await saga(orderId).result()).toBe('COMPENSATED');
      expect(await orderStatus(orderId)).toBe('REJECTED');
      expect((await readReservationOrder(app, orderId))?.status).toBe('FENCED');
      expect(await reservationsFor(app, orderId)).toEqual([]);
      await expect(sagaEngine(app).ensureStarted(start)).rejects.toBeInstanceOf(CheckoutSagaClosedError);
    });

    it('leaves a running saga untouched', async () => {
      const { orderId, start } = await placeHeld();

      await sagaEngine(app).ensureStarted(start);

      expect((await saga(orderId).query(stateQuery)).step).toBe('AWAITING_AUTH');
      expect(await orderEvents(orderId)).toEqual(['order.placed']);
    });
  });

  describe('two apps polling one task queue', () => {
    let second: INestApplication;

    beforeAll(async () => {
      ({ app: second } = await createTestAppWithPool(SAGA_ENV));
      extraApps.push(second);
      await workerRunning(second);
    });
    afterAll(async () => {
      extraApps.splice(extraApps.indexOf(second), 1);
      await second?.close();
    });

    it('takes every saga to PAID exactly once', async () => {
      const apps = [app, second, app, second];
      const placed = await Promise.all(apps.map((engineApp) => placeHeld(engineApp)));
      await Promise.all(placed.map(({ orderId }, index) => payThroughSaga(orderId, apps[(index + 1) % apps.length])));

      for (const { orderId } of placed) {
        await untilOrderIs(orderId, 'PAID');
        expect((await orderEvents(orderId)).sort()).toEqual(['order.paid', 'order.placed']);
        expect(paymentService.providerCaptures(orderId)).toBe(1);
      }
    });
  });

  describe('payment deadline', () => {
    let expiryApp: INestApplication;
    const deadlineMs = Number(SHORT_DEADLINE_ENV.CHECKOUT_PAYMENT_DEADLINE_SEC) * 1000;
    const graceMs = Number(SHORT_DEADLINE_ENV.SAGA_AUTH_GRACE_SEC) * 1000;

    beforeAll(async () => {
      // Its own queue: the main app is still polling the file's queue with its own settings.
      ({ app: expiryApp } = await createTestAppWithPool({
        ...SAGA_ENV,
        ...SHORT_DEADLINE_ENV,
        TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('expiry'),
      }));
      extraApps.push(expiryApp);
      await workerRunning(expiryApp);
    });
    afterAll(async () => {
      extraApps.splice(extraApps.indexOf(expiryApp), 1);
      await expiryApp?.close();
    });

    it('expires an order nobody pays for and gives the stock back', async () => {
      const { orderId, variantId, start } = await placeReserving({ deadlineMs });
      await expect(sagaEngine(expiryApp).reserve(start)).resolves.toBe('HELD');

      await untilOrderIs(orderId, 'EXPIRED', deadlineMs + graceMs + 5000);

      expect(await saga(orderId).result()).toBe('COMPENSATED');
      expect(await reservedOf(variantId)).toBe(0);
    });
  });
});
