import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { DomainEventProcessor, InboxStore } from '@jcool/messaging';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
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
import { RunCheckoutInvariantsUseCase } from '../../src/modules/order/application/use-cases';
import { stateQuery } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { CheckoutReservingReaperScheduler } from '../../src/modules/order/interface/checkout-reserving-reaper.scheduler';
import { CHECKOUT_SAGA_DEFAULTS } from '../../src/shared/config/checkout-saga.config';
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import {
  SHORT_DEADLINE_CHECKOUT_ENV,
  failOnce,
  hangAfter,
  holdCalls,
  orderEventTypes,
  relayAuthorization,
  relayedAuthorizations,
  releaseHung,
  sagaHandle,
  shortSessionFloorBeforeEach,
} from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder } from '../setup/fixtures/inventory.fixture';
import {
  auditLedgerInvariants,
  authorizePayment,
  buyerWithCart,
  checkout,
  openSession,
  readOrder,
  readPaymentOrder,
  readStock,
  reservationsFor,
  seedSellableSku,
  untilOrderStatus,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';
import { sleep } from '../setup/sleep';

const ON_HAND = 5;
const ACTIVITY_TIMEOUT_MS = 11_000;
const RETRY_BASE_MS = 200;
const TRY_TIMEOUT_MS = CHECKOUT_SAGA_DEFAULTS.CHECKOUT_TRY_TIMEOUT_MS;
const CANCEL_WAIT_MS = 3_000;
const ORPHAN_SEC = 7;
const SHUTDOWN_GRACE_MS = 1_000;
const SHUTDOWN_FORCE_MS = 2_000;
// From the abandoned attempt to the saga settled: the server times the attempt out, backs off once,
// and the retry finds the change already applied.
const CONVERGE_MS = ACTIVITY_TIMEOUT_MS + RETRY_BASE_MS + 5_000;
const CASE_TIMEOUT_MS = CONVERGE_MS + 10_000;

// Four activity slots: every hung attempt keeps one until the test releases it. 5 queue + 4 + 2 local
// + 5 spare stays inside the pool of 20.
const CRASH_ENV = {
  SAGA_ACTIVITY_TIMEOUT_MS: String(ACTIVITY_TIMEOUT_MS),
  PAYMENT_COMMAND_TIMEOUT_MS: '5000',
  SAGA_RETRY_BASE_MS: String(RETRY_BASE_MS),
  SAGA_RETRY_CAP_MS: '2000',
  SAGA_ACTIVITY_CONCURRENCY: '4',
  DB_POOL_MAX: '20',
  CHECKOUT_RESERVING_ORPHAN_SEC: String(ORPHAN_SEC),
  CHECKOUT_CANCEL_WAIT_MS: String(CANCEL_WAIT_MS),
  TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: String(SHUTDOWN_GRACE_MS),
  TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: String(SHUTDOWN_FORCE_MS),
  CHECKOUT_INVARIANT_SETTLE_SEC: '0',
};

const inventoryOf = (app: INestApplication) => app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT);
const paymentOf = (app: INestApplication) => app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT);
const ordersOf = (app: INestApplication) => app.get<OrderRepositoryPort>(ORDER_REPOSITORY);

let payment: PaymentServiceStub;

beforeAll(async () => {
  payment = await paymentServiceStub();
});

async function expectSettledCleanly(app: INestApplication, sku: SellableSku): Promise<void> {
  expect((await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).violations).toEqual([]);
  // Until visibility sees the run closed, the checker skips the order as still running.
  const run = await eventually(
    () => app.get(RunCheckoutInvariantsUseCase).execute(),
    ({ checked }) => checked === 1,
  );
  expect(run.result).toBe('ok');
}

async function placed(app: INestApplication) {
  const sku = await seedSellableSku(app, { onHand: ON_HAND });
  const token = await buyerWithCart(app, sku.variantId);
  const orderId = (await checkout(app, token).expect(201)).body.id as string;
  return { sku, token, orderId };
}

async function placedWithSession(app: INestApplication) {
  const order = await placed(app);
  await openSession(app, order.token, order.orderId).expect(201);
  return order;
}

describe('Checkout saga crash convergence (integration, real Temporal, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool(CRASH_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  // A hung call would otherwise hold its activity slot, and the last case's would hold vitest open.
  afterEach(() => {
    releaseHung();
    vi.restoreAllMocks();
  });

  async function buyerWithKey(sku: SellableSku) {
    const token = await buyerWithCart(app, sku.variantId);
    const key = idempotencyKeyHeader();
    return {
      key: key['Idempotency-Key'],
      post: () => request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(key),
    };
  }

  it('rejects an order whose saga never started once the reaper hands it over', async () => {
    const sku = await seedSellableSku(app, { onHand: ON_HAND });
    const { post } = await buyerWithKey(sku);
    failOnce(app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE), 'reserve', {
      error: new CheckoutEngineUnavailableError(),
    });

    await post().expect(503);
    const [{ id: orderId }] = (await pool.query<{ id: string }>("SELECT id FROM orders WHERE status = 'RESERVING'"))
      .rows;
    await sleep(ORPHAN_SEC * 1000 + 200);

    await app.get(CheckoutReservingReaperScheduler).tick();

    await untilOrderStatus(app, orderId, 'REJECTED');
    const order = await readOrder(app, orderId);
    expect(order.finalizeReason).toBe('saga:abandoned');
    expect(order.finalizedAt).not.toBeNull();
    await expect.poll(async () => (await readReservationOrder(app, orderId))?.status).toBe('FENCED');
    expect(await reservationsFor(app, orderId)).toEqual([]);
    await expectSettledCleanly(app, sku);
  });

  it('rejects the order and releases the hold when the Try reserved but never answered', async () => {
    const sku = await seedSellableSku(app, { onHand: ON_HAND });
    const { post } = await buyerWithKey(sku);
    const tryReserve = hangAfter(inventoryOf(app), 'tryReserve');

    const startedAt = Date.now();
    await post().expect(503);
    await tryReserve.reached;
    const [{ id: orderId }] = (await pool.query<{ id: string }>('SELECT id FROM orders')).rows;

    await untilOrderStatus(app, orderId, 'REJECTED', startedAt + TRY_TIMEOUT_MS + 1000 - Date.now());
    expect((await readOrder(app, orderId)).finalizeReason).toBe('saga:try_timeout');
    await expect.poll(async () => (await readReservationOrder(app, orderId))?.status).toBe('RELEASED');
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);
    await expectSettledCleanly(app, sku);
  });

  it(
    'places the order once when tx B committed but its local activity never answered',
    async () => {
      const sku = await seedSellableSku(app, { onHand: ON_HAND });
      const { key, post } = await buyerWithKey(sku);
      const applyTryResult = hangAfter(ordersOf(app), 'applyTryResult');

      await post().expect(503);
      await applyTryResult.reached;
      const reachedAt = Date.now();
      const [{ id: orderId }] = (await pool.query<{ id: string }>('SELECT id FROM orders')).rows;
      expect(await readOrder(app, orderId)).toMatchObject({ status: 'PENDING', idempotencyKey: key });

      await eventually(
        async () => (await sagaHandle(app, orderId).query(stateQuery)).step,
        (step) => step === 'AWAITING_AUTH',
        reachedAt + CONVERGE_MS - Date.now(),
      );
      expect(applyTryResult.calls()).toBe(2);
      expect(await orderEventTypes(app, orderId)).toEqual(['order.placed']);
      const replay = await post().expect(201);
      expect(replay.body).toMatchObject({ id: orderId, status: 'PENDING' });
      expect(await orderEventTypes(app, orderId)).toEqual(['order.placed']);
    },
    CASE_TIMEOUT_MS,
  );

  it('pays once when the claim of a delivered authorization did not commit', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    // Keeps the run open, so the redelivery meets it rather than a closed one.
    const capture = holdCalls(paymentOf(app), 'capture');
    const claim = failOnce(app.get(InboxStore), 'claim');
    const [job] = await relayedAuthorizations(app, orderId);
    const processor = app.get(DomainEventProcessor);

    await expect(processor.process(job.data, ORDER_EVENTS_QUEUE)).rejects.toThrow('failure injected by the test');
    await expect(processor.process(job.data, ORDER_EVENTS_QUEUE)).resolves.toBe('processed');
    capture.release();

    await untilOrderStatus(app, orderId, 'PAID');
    expect(claim.calls()).toBe(2);
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectSettledCleanly(app, sku);
  });

  it('pays once the authorization reaches Temporal on redelivery', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    failOnce(app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE), 'notifyAuthorized', {
      orderId,
      error: new CheckoutEngineUnavailableError(),
    });
    const [job] = await relayedAuthorizations(app, orderId);
    const processor = app.get(DomainEventProcessor);

    await expect(processor.process(job.data, ORDER_EVENTS_QUEUE)).rejects.toBeInstanceOf(
      CheckoutEngineUnavailableError,
    );
    expect((await pool.query('SELECT 1 FROM inbox')).rowCount).toBe(0);
    await expect(processor.process(job.data, ORDER_EVENTS_QUEUE)).resolves.toBe('processed');

    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectSettledCleanly(app, sku);
  });

  it(
    'pays when the stock commit was applied but its activity never answered',
    async () => {
      const { sku, orderId } = await placedWithSession(app);
      const commit = hangAfter(inventoryOf(app), 'commit', { orderId });
      await authorizePayment(orderId);
      await relayAuthorization(app, orderId);

      await commit.reached;
      const reachedAt = Date.now();

      await untilOrderStatus(app, orderId, 'PAID', reachedAt + CONVERGE_MS - Date.now());
      expect(commit.calls()).toBe(2);
      expect(payment.providerCaptures(orderId)).toBe(1);
      expect((await reservationsFor(app, orderId)).map(({ status }) => status)).toEqual(['COMMITTED']);
      await expectSettledCleanly(app, sku);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'pays once when the capture was applied but its activity never answered',
    async () => {
      const { sku, orderId } = await placedWithSession(app);
      const capture = hangAfter(paymentOf(app), 'capture', { orderId });
      await authorizePayment(orderId);
      await relayAuthorization(app, orderId);

      await capture.reached;
      const reachedAt = Date.now();

      await untilOrderStatus(app, orderId, 'PAID', reachedAt + CONVERGE_MS - Date.now());
      expect(capture.calls()).toBe(2);
      expect(payment.providerCaptures(orderId)).toBe(1);
      await expectSettledCleanly(app, sku);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'writes order.paid once when the PAID change committed but its activity never answered',
    async () => {
      const { sku, orderId } = await placedWithSession(app);
      // Held past CONFIRMING, so the next order change is the PAID one.
      const capture = holdCalls(paymentOf(app), 'capture');
      await authorizePayment(orderId);
      await relayAuthorization(app, orderId);
      await capture.waitForCalls(1);
      const paid = hangAfter(ordersOf(app), 'applyOrderChange', { orderId });
      capture.release();

      await paid.reached;
      const reachedAt = Date.now();
      expect((await readOrder(app, orderId)).status).toBe('PAID');

      await expect(
        Promise.race([
          sagaHandle(app, orderId).result(),
          sleep(reachedAt + CONVERGE_MS - Date.now()).then(() => 'still running'),
        ]),
      ).resolves.toBe('COMPLETED');
      expect(paid.calls()).toBe(2);
      expect((await orderEventTypes(app, orderId)).filter((type) => type === 'order.paid')).toHaveLength(1);
      await expectSettledCleanly(app, sku);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'answers the cancel and compensates when the payment cancel was applied but never answered',
    async () => {
      const { sku, token, orderId } = await placedWithSession(app);
      const cancelPayment = hangAfter(paymentOf(app), 'cancel', { orderId });

      const startedAt = Date.now();
      const cancelled = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set(authHeader(token))
        .expect(200);
      expect(Date.now() - startedAt).toBeLessThan(CANCEL_WAIT_MS + 2_000);
      expect(cancelled.body).toMatchObject({ id: orderId, status: 'CANCELLED' });

      await cancelPayment.reached;
      const reachedAt = Date.now();

      await expect(
        Promise.race([
          sagaHandle(app, orderId).result(),
          sleep(reachedAt + CONVERGE_MS - Date.now()).then(() => 'still running'),
        ]),
      ).resolves.toBe('COMPENSATED');
      expect(cancelPayment.calls()).toBe(2);
      expect((await readPaymentOrder(app, orderId))?.status).toBe('CANCELLED');
      expect((await readReservationOrder(app, orderId))?.status).toBe('RELEASED');
      expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);
      await expectSettledCleanly(app, sku);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('Checkout saga crash convergence: abandoned session (integration, short payment window)', () => {
  const GRACE_MS = Number(SHORT_DEADLINE_CHECKOUT_ENV.SAGA_AUTH_GRACE_SEC) * 1000;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({
      ...SHORT_DEADLINE_CHECKOUT_ENV,
      CHECKOUT_INVARIANT_SETTLE_SEC: '0',
    }));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  shortSessionFloorBeforeEach();

  it('expires an order whose buyer opened a session and walked away', async () => {
    const { sku, orderId } = await placedWithSession(app);
    const deadlineMs = ((await readOrder(app, orderId)).paymentDeadlineAt as Date).getTime();

    await untilOrderStatus(app, orderId, 'EXPIRED', deadlineMs + GRACE_MS + 5_000 - Date.now());

    // The order turns EXPIRED first; the compensations land before the run closes.
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    expect(payment.sessionFor(orderId)?.status).toBe('EXPIRED');
    expect((await readReservationOrder(app, orderId))?.status).toBe('RELEASED');
    await expectSettledCleanly(app, sku);
  });
});

describe('Checkout saga crash convergence: worker restart (integration, two apps on one task queue)', () => {
  let first: INestApplication;
  let firstPool: Pool;
  let second: INestApplication | undefined;
  let firstClosed = false;

  beforeAll(async () => {
    ({ app: first, pool: firstPool } = await createTestAppWithPool(CRASH_ENV));
  });
  afterAll(async () => {
    if (!firstClosed) await first.close();
  });
  closeAppAfterAll(() => second);
  resetSagasAndDatabaseBeforeEach(
    () => [first],
    () => firstPool,
  );
  afterEach(() => {
    releaseHung();
    vi.restoreAllMocks();
  });

  it(
    'pays on the next worker when the first one dies in the middle of a capture',
    async () => {
      const { sku, orderId } = await placedWithSession(first);
      const capture = hangAfter(paymentOf(first), 'capture', { orderId });
      await authorizePayment(orderId);
      await relayAuthorization(first, orderId);
      await capture.reached;
      const reachedAt = Date.now();

      const closingAt = Date.now();
      await first.close();
      firstClosed = true;
      expect(Date.now() - closingAt).toBeLessThan(SHUTDOWN_GRACE_MS + SHUTDOWN_FORCE_MS + 5_000);
      ({ app: second } = await createTestAppWithPool(CRASH_ENV));
      const retried = vi.spyOn(paymentOf(second), 'capture');

      await untilOrderStatus(second, orderId, 'PAID', reachedAt + CONVERGE_MS - Date.now());
      expect(capture.calls() + retried.mock.calls.length).toBe(2);
      expect(payment.providerCaptures(orderId)).toBe(1);
      expect((await readPaymentOrder(second, orderId))?.status).toBe('CAPTURED');
      expect((await reservationsFor(second, orderId)).map(({ status }) => status)).toEqual(['COMMITTED']);
      await expectSettledCleanly(second, sku);
    },
    CASE_TIMEOUT_MS + 20_000,
  );
});
