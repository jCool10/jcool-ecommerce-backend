import type { INestApplication } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutSagaWriter } from '../../src/modules/order/application/saga/checkout-saga.writer';
import { SagaKickExecutor } from '../../src/modules/order/application/saga/saga-kick.executor';
import { AdvanceCheckoutSagaUseCase } from '../../src/modules/order/application/use-cases/advance-checkout-saga.use-case';
import { CheckoutSagaRunnerScheduler } from '../../src/modules/order/interface/checkout-saga-runner.scheduler';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { deliverDomainEventsOnce, drainDomainEvents } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  lapseSagaDeadline,
  newRunnerInstance,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readPayment,
  readReservationOrder,
  readSaga,
  readStock,
  seedSellableSku,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_runner_01';
const BATCH_SIZE = 3;
const ON_HAND = 20;

describe('Checkout saga runner (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let runner: CheckoutSagaRunnerScheduler;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      SAGA_RUNNER_BATCH_SIZE: String(BATCH_SIZE),
    }));
    runner = app.get(CheckoutSagaRunnerScheduler);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeDue = (orderIds: string[]) =>
    db
      .update(schema.checkoutSagas)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(inArray(schema.checkoutSagas.orderId, orderIds));

  /** What a crashed or stalled owner leaves behind: a saga that is due and no longer leased. */
  const expireLease = (orderId: string) =>
    db
      .update(schema.checkoutSagas)
      .set({ leaseUntil: sql`now() - interval '1 second'`, nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(schema.checkoutSagas.orderId, orderId));

  /** Leaves the saga CAPTURING and backing off: the first capture times out with nothing stored. */
  async function captureTimesOut(order: OpenOrder): Promise<string> {
    const intentId = gateway.authorize(order.sessionId);
    await postAuthorizationWebhook(app, gateway, order);
    gateway.failCapture(intentId, 'timeout');
    await drainDomainEvents(app);
    expect((await readSaga(app, order.orderId)).step).toBe('CAPTURING');
    return intentId;
  }

  /** The next release waits at a gate the test opens, before it touches the database. */
  function parkNextRelease() {
    const participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    const release = participant.release.bind(participant);
    let arrive!: () => void;
    let open!: () => void;
    const entered = new Promise<void>((resolve) => (arrive = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    const calls = vi.spyOn(participant, 'release').mockImplementationOnce(async (orderId) => {
      arrive();
      await gate;
      return release(orderId);
    });
    return { entered, open, calls };
  }

  it('advances each due saga once when two replicas tick at the same time', async () => {
    const orders: OpenOrder[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) orders.push(await placeAndOpenSession(app, sku));
    const intentIds: string[] = [];
    for (const order of orders) intentIds.push(await captureTimesOut(order));
    await makeDue(orders.map(({ orderId }) => orderId));

    await Promise.all([runner.tick(), (await newRunnerInstance(app)).tick()]);

    for (const [i, order] of orders.entries()) {
      expect((await readOrder(app, order.orderId)).status).toBe('PAID');
      expect(gateway.requestKeys(intentIds[i])).toHaveLength(2);
      expect(gateway.captureCalls(intentIds[i])).toBe(1);
    }
  });

  it.each([
    { died: 'after its Try held stock', failTry: false, header: 'RELEASED' },
    { died: 'before its Try answered', failTry: true, header: 'FENCED' },
  ])('rejects a checkout whose request died $died once its lease runs out, and frees its stock', async (crash) => {
    if (crash.failTry) {
      vi.spyOn(app.get<InventoryParticipant>(INVENTORY_PARTICIPANT), 'tryReserve').mockRejectedValueOnce(
        new Error('connection reset'),
      );
    }
    vi.spyOn(app.get(CheckoutSagaWriter), 'applyLeased').mockRejectedValueOnce(new Error('process killed'));
    const token = await buyerWithCart(app, sku.variantId, 2);
    await checkout(app, token).expect(500);
    const [{ id: orderId }] = await db.select({ id: schema.orders.id }).from(schema.orders);

    // Its lease says the request may still be running, so the runner keeps its hands off.
    await runner.tick();
    expect((await readOrder(app, orderId)).status).toBe('RESERVING');

    await expireLease(orderId);
    await runner.tick();

    const order = await readOrder(app, orderId);
    expect(order).toMatchObject({ status: 'REJECTED', finalizeReason: 'try:abandoned' });
    expect(order.finalizedAt).toBeInstanceOf(Date);
    expect(await readSaga(app, orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: crash.header });
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });

  it('lets another replica take a saga whose lease ran out, and stops the old owner before its next call', async () => {
    const order = await placeAndOpenSession(app, sku);
    await lapseSagaDeadline(app, order.orderId);
    const expireSession = vi.spyOn(gateway, 'expireSession');
    const release = parkNextRelease();

    const oldOwner = runner.tick();
    try {
      await release.entered;
      await expireLease(order.orderId);
      await (await newRunnerInstance(app)).tick();
    } finally {
      release.open();
      await oldOwner;
    }

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(release.calls).toHaveBeenCalledTimes(2);
    expect(expireSession).toHaveBeenCalledTimes(1);
  });

  it('advances a due saga on the first tick however many sagas are parked awaiting authorization', async () => {
    const parked: OpenOrder[] = [];
    for (let i = 0; i < BATCH_SIZE + 5; i++) parked.push(await placeAndOpenSession(app, sku));
    const due = await placeAndOpenSession(app, sku);
    const intentId = await captureTimesOut(due);
    await makeDue([due.orderId]);
    const parkedBefore = await Promise.all(parked.map(({ orderId }) => readSaga(app, orderId)));
    const advance = vi.spyOn(app.get(AdvanceCheckoutSagaUseCase), 'execute');

    await runner.tick();

    expect(advance.mock.calls).toEqual([[due.orderId]]);
    expect((await readOrder(app, due.orderId)).status).toBe('PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await Promise.all(parked.map(({ orderId }) => readSaga(app, orderId)))).toEqual(parkedBefore);
  });

  it('leaves a saga to the kick that holds its lease, so the hold is captured once', async () => {
    const order = await placeAndOpenSession(app, sku);
    const intentId = gateway.authorize(order.sessionId);
    const capture = gateway.hangCapture(intentId);
    await postAuthorizationWebhook(app, gateway, order);

    try {
      await deliverDomainEventsOnce(app);
      await capture.entered;
      await makeDue([order.orderId]);

      await runner.tick();

      expect((await readSaga(app, order.orderId)).step).toBe('CAPTURING');
    } finally {
      capture.release();
      await app.get(SagaKickExecutor).drain();
    }
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(gateway.requestKeys(intentId)).toHaveLength(1);
    expect(gateway.captureCalls(intentId)).toBe(1);
  });

  it('makes a compensating pass lose to an authorization written under it, then voids that hold on the rerun', async () => {
    const order = await placeAndOpenSession(app, sku);
    await lapseSagaDeadline(app, order.orderId);
    const release = parkNextRelease();
    let intentId: string;

    const pass = runner.tick();
    try {
      await release.entered;
      intentId = gateway.authorize(order.sessionId);
      await postAuthorizationWebhook(app, gateway, order);
      // The handler rewrites the saga under the pass's lease; its own kick finds the lease taken.
      await drainDomainEvents(app);
    } finally {
      release.open();
      await pass;
    }

    expect(await readSaga(app, order.orderId)).toMatchObject({
      step: 'COMPENSATING',
      pendingCompensations: ['RELEASE_STOCK', 'CANCEL_PAYMENT'],
    });
    expect(gateway.wasVoided(intentId)).toBe(false);

    await expireLease(order.orderId);
    await runner.tick();

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect((await readPayment(app, order.orderId)).status).toBe('VOIDED');
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(gateway.captureCalls(intentId)).toBe(0);
    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });
});
