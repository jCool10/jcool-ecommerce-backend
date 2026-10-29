import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
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
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import {
  SHORT_DEADLINE_CHECKOUT_ENV,
  holdCalls,
  relayAuthorization,
  sagaHandle,
  shortSessionFloorBeforeEach,
} from '../setup/fixtures/checkout-saga.fixture';
import {
  auditLedgerInvariants,
  authorizePayment,
  buyerWithCart,
  checkout,
  openSession,
  readOrder,
  readStock,
  seedSellableSku,
  untilOrderStatus,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';

const CANCEL_WAIT_MS = 3000;
const GRACE_MS = Number(SHORT_DEADLINE_CHECKOUT_ENV.SAGA_AUTH_GRACE_SEC) * 1000;
const ON_HAND = 5;

describe('Checkout saga cancel (integration, real Temporal, real HTTP, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let payment: PaymentServiceStub;

  beforeAll(async () => {
    payment = await paymentServiceStub();
    ({ app, pool } = await createTestAppWithPool({
      ...SHORT_DEADLINE_CHECKOUT_ENV,
      CHECKOUT_CANCEL_WAIT_MS: String(CANCEL_WAIT_MS),
    }));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  shortSessionFloorBeforeEach();

  const server = () => app.getHttpServer();
  const cancel = (token: string, orderId: string) =>
    request(server()).post(`/orders/${orderId}/cancel`).set(authHeader(token));

  async function placed(): Promise<{ sku: SellableSku; token: string; orderId: string }> {
    const sku = await seedSellableSku(app, { onHand: ON_HAND });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    return { sku, token, orderId };
  }

  const expectCleanLedger = async (sku: SellableSku) =>
    expect((await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).violations).toEqual([]);

  it('has the stock back by the time cancel answers 200, and answers a repeat the same', async () => {
    const { sku, token, orderId } = await placed();
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(1);

    const first = await cancel(token, orderId).expect(200);

    expect(first.body).toMatchObject({ id: orderId, status: 'CANCELLED', finalizeReason: 'user:cancel' });
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);
    await cancel(token, orderId).expect(200);
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    await expectCleanLedger(sku);
  });

  it('answers 409 while the payment is being taken, and the order still completes', async () => {
    const { sku, token, orderId } = await placed();
    const commit = holdCalls(app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT), 'commit');
    await openSession(app, token, orderId).expect(201);
    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await commit.waitForCalls(1);

    const refused = await cancel(token, orderId).expect(409);

    expect(refused.body.message).toBe('Order cannot be cancelled in status CONFIRMING');
    commit.release();
    await untilOrderStatus(app, orderId, 'PAID');
    await expectCleanLedger(sku);
  });

  it('answers 409 from the saga once the payment is verified, though the order still reads PENDING', async () => {
    const { sku, token, orderId } = await placed();
    const confirming = holdCalls(app.get<OrderRepositoryPort>(ORDER_REPOSITORY), 'applyOrderChange');
    await openSession(app, token, orderId).expect(201);
    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await confirming.waitForCalls(1);
    expect((await readOrder(app, orderId)).status).toBe('PENDING');

    const refused = await cancel(token, orderId).expect(409);

    expect(refused.body.message).toBe('Order cannot be cancelled while its payment is being taken');
    confirming.release();
    await untilOrderStatus(app, orderId, 'PAID');
    await expectCleanLedger(sku);
  });

  it('answers 409 for an order whose saga expired it', async () => {
    const { sku, token, orderId } = await placed();
    const deadlineMs = ((await readOrder(app, orderId)).paymentDeadlineAt as Date).getTime();
    await untilOrderStatus(app, orderId, 'EXPIRED', deadlineMs + GRACE_MS + 5000 - Date.now());

    const refused = await cancel(token, orderId).expect(409);

    expect(refused.body.message).toBe('Order cannot be cancelled in status EXPIRED');
    // The order turns EXPIRED before its compensations run, so the ledger is only final once the run is.
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    await expectCleanLedger(sku);
  });

  it('stamps an admin cancel as such', async () => {
    const { sku, orderId } = await placed();
    const admin = (await createTestAdminPrincipal(app)).accessToken;

    const res = await request(server()).post(`/admin/orders/${orderId}/cancel`).set(authHeader(admin)).expect(200);

    expect(res.body).toMatchObject({ status: 'CANCELLED', finalizeReason: 'admin:cancel' });
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);
    await expectCleanLedger(sku);
  });

  it('answers 200 once the cancel is recorded, even while payment is slow to close the session', async () => {
    const { sku, token, orderId } = await placed();
    await openSession(app, token, orderId).expect(201);
    const paymentCancel = holdCalls(app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT), 'cancel');

    const startedAt = Date.now();
    const res = await cancel(token, orderId).expect(200);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CANCEL_WAIT_MS);
    expect(res.body).toMatchObject({ id: orderId, status: 'CANCELLED' });
    paymentCancel.release();
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    await expectCleanLedger(sku);
  });

  it('lets exactly one of a cancel and an authorization win the race', async () => {
    const { sku, token, orderId } = await placed();
    await openSession(app, token, orderId).expect(201);
    await authorizePayment(orderId);

    const [cancelled] = await Promise.all([cancel(token, orderId), relayAuthorization(app, orderId)]);

    expect(await sagaHandle(app, orderId).result()).toMatch(/^(COMPLETED|COMPENSATED)$/);
    const { status } = await readOrder(app, orderId);
    if (status === 'CANCELLED') {
      expect(cancelled.status).toBe(200);
      await eventually(
        () => payment.sessionFor(orderId)?.status,
        (attempt) => attempt === 'VOIDED',
      );
      expect(payment.providerCaptures(orderId)).toBe(0);
    } else {
      expect(status).toBe('PAID');
      expect(cancelled.status).toBe(409);
      expect(payment.providerCaptures(orderId)).toBe(1);
    }
    await expectCleanLedger(sku);
  });
});
