import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKOUT_SAGA_SETTINGS,
  type CheckoutSagaSettings,
} from '../../src/modules/order/application/saga/checkout-saga.settings';
import { CheckoutSagaRunnerScheduler } from '../../src/modules/order/interface/checkout-saga-runner.scheduler';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { drainDomainEvents } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  authorizeAndRelay,
  buyerWithCart,
  checkout,
  lapseSagaDeadline,
  openSession,
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

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_expiry_01';
const ON_HAND = 5;
const QUANTITY = 2;

describe('Checkout saga, payment deadline (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let runner: CheckoutSagaRunnerScheduler;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    runner = app.get(CheckoutSagaRunnerScheduler);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  const reportAuthorization = (order: OpenOrder) => postAuthorizationWebhook(app, gateway, order);

  const moveDeadline = (orderId: string, deadlineAt: Date) =>
    db
      .update(schema.checkoutSagas)
      .set({ deadlineAt, nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(schema.checkoutSagas.orderId, orderId));

  const orderEvent = (orderId: string, eventType: string) =>
    db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.aggregateId, orderId), eq(schema.outbox.eventType, eventType)));

  it('expires an order the runner finds past its deadline and grace, closing the session and the hold', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapseSagaDeadline(app, order.orderId);

    await runner.tick();

    expect(await readOrder(app, order.orderId)).toMatchObject({ status: 'EXPIRED', finalizeReason: 'saga:deadline' });
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(gateway.wasExpired(order.sessionId)).toBe(true);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    expect(await orderEvent(order.orderId, 'order.expired')).toHaveLength(1);
    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });

  it('voids a hold whose authorization is relayed only after the order expired, never capturing it', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const intentId = gateway.authorize(order.sessionId);
    await reportAuthorization(order);
    await lapseSagaDeadline(app, order.orderId);
    await runner.tick();

    await drainDomainEvents(app);

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect((await readPayment(app, order.orderId)).status).toBe('VOIDED');
    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });

  it('voids a hold placed just before the expiry closed the page, and ignores its webhook after', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const intentId = gateway.authorize(order.sessionId);
    await lapseSagaDeadline(app, order.orderId);
    await runner.tick();

    await reportAuthorization(order);
    await drainDomainEvents(app);

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect((await readPayment(app, order.orderId)).status).toBe('VOIDED');
  });

  it('still takes an authorization that lands past the deadline but inside the grace', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await moveDeadline(order.orderId, new Date(Date.now() - 60_000));
    await runner.tick();
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'AWAITING_AUTH', pendingCompensations: [] });

    const { intentId } = await authorizeAndRelay(app, gateway, order);

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPLETED', pendingCompensations: [] });
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(gateway.wasVoided(intentId)).toBe(false);
  });

  it('refuses to open a payment page once too little of the deadline is left to finish it', async () => {
    const token = await buyerWithCart(app, sku.variantId, QUANTITY);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    const { payCutoffMs } = app.get<CheckoutSagaSettings>(CHECKOUT_SAGA_SETTINGS);
    await moveDeadline(orderId, new Date(Date.now() + payCutoffMs - 60_000));

    const refused = await openSession(app, token, orderId).expect(409);

    expect(refused.body.message).toBe('Payment window closed');
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
  });

  it('releases the hold at once while a session that will not close keeps the saga compensating', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    gateway.failExpireSession(order.sessionId);
    await lapseSagaDeadline(app, order.orderId);

    await runner.tick();

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityReserved: 0 });
    const saga = await readSaga(app, order.orderId);
    expect(saga).toMatchObject({ step: 'COMPENSATING', pendingCompensations: ['CANCEL_PAYMENT'] });
    expect(saga.lastError).toEqual(expect.any(String));
  });
});
