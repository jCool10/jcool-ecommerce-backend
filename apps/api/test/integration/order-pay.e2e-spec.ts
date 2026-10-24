import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { PaymentGatewayError } from '../../src/modules/payment/application/ports/payment-gateway.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { SHORT_DEADLINE_CHECKOUT_ENV } from '../setup/fixtures/checkout-saga.fixture';
import {
  addToCart,
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  driveToPaid,
  openSession,
  readOrder,
  readPayment,
  readPaymentOrder,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal, newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_order_pay_secret_0001';
const PRICE = 120_000;
const PAY_CUTOFF_MS = Number(SHORT_DEADLINE_CHECKOUT_ENV.CHECKOUT_PAY_CUTOFF_SEC) * 1000;

describe('POST /orders/:id/pay (integration, real Temporal, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SHORT_DEADLINE_CHECKOUT_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function placed(options: { priceMinor?: number; quantity?: number } = {}) {
    const sku = await seedSellableSku(app, { onHand: 20, priceMinor: options.priceMinor ?? PRICE });
    const token = await buyerWithCart(app, sku.variantId, options.quantity ?? 1);
    const res = await checkout(app, token).expect(201);
    return { token, orderId: res.body.id as string, totalMinor: res.body.totalAmountMinor as number };
  }

  const expectCleanLedger = async () => expect((await auditLedgerInvariants(app)).violations).toEqual([]);

  it('opens a session for the order total that dies at the payment deadline', async () => {
    const { token, orderId, totalMinor } = await placed({ quantity: 2 });

    const res = await openSession(app, token, orderId).expect(201);

    expect(res.body).toMatchObject({ paymentId: expect.any(String), providerSessionId: expect.any(String) });
    const order = await readOrder(app, orderId);
    expect(gateway.lastCreateSessionInput()).toMatchObject({
      orderId,
      amountMinor: totalMinor,
      currency: 'VND',
      expiresAt: order.paymentDeadlineAt,
    });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'OPEN', amountMinor: totalMinor });
    expect(await readPayment(app, orderId)).toMatchObject({ id: res.body.paymentId, status: 'PENDING' });
  });

  it("answers 404 for another buyer's order and for an unknown id", async () => {
    const { orderId } = await placed();
    const stranger = await newPrincipalToken(app);

    await openSession(app, stranger, orderId).expect(404);
    await openSession(app, stranger, testId()).expect(404);
    await expectCleanLedger();
  });

  it('answers 404 for an order the buyer cannot see yet: still RESERVING', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    const reserving = Order.create(user.id, 'VND', [OrderItem.of(testId(), 'Widget', PRICE, 1)]).reserve(
      new Date(),
      new Date(Date.now() + 60_000),
    );
    const { order } = await app
      .get<OrderRepositoryPort>(ORDER_REPOSITORY)
      .createReserving({ order: reserving, idempotencyKey: null });

    await openSession(app, accessToken, order.id as string).expect(404);
  });

  it('answers 404 for an order the buyer never sees: REJECTED', async () => {
    const sku = await seedSellableSku(app, { onHand: 0 });
    const { user, accessToken } = await createTestPrincipal(app);
    await addToCart(app, accessToken, sku.variantId);
    await checkout(app, accessToken).expect(409);
    const [rejected] = await db.select().from(schema.orders).where(eq(schema.orders.userId, user.id));
    expect(rejected.status).toBe('REJECTED');

    await openSession(app, accessToken, rejected.id).expect(404);
    await expectCleanLedger();
  });

  it('answers 409 once the order has settled', async () => {
    const { token, orderId } = await placed();
    await driveToPaid(app, token, orderId);

    const res = await openSession(app, token, orderId).expect(409);

    expect(res.body.message).toBe('Order is not payable in status PAID');
    await expectCleanLedger();
  });

  it('answers 409 once too little of the payment window is left to pay in', async () => {
    const { token, orderId } = await placed();
    const { paymentDeadlineAt } = await readOrder(app, orderId);
    await sleep((paymentDeadlineAt as Date).getTime() - PAY_CUTOFF_MS - Date.now() + 250);

    await openSession(app, token, orderId).expect(409);

    expect(await readPaymentOrder(app, orderId)).toBeUndefined();
  });

  it('answers 409 when payment has already closed the order to new sessions', async () => {
    const { token, orderId } = await placed();
    await app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT).cancel(orderId);

    await openSession(app, token, orderId).expect(409);

    expect((await readOrder(app, orderId)).status).toBe('PENDING');
  });

  it('answers 502 when the provider refuses, leaving no payment attempt behind', async () => {
    const { token, orderId } = await placed();
    vi.spyOn(gateway, 'createSession').mockRejectedValueOnce(new PaymentGatewayError('circuit open'));

    await openSession(app, token, orderId).expect(502);

    expect(await readPayment(app, orderId)).toBeUndefined();
    await openSession(app, token, orderId).expect(201);
  });

  it('opens a session for a total above the int4 ceiling', async () => {
    const { token, orderId, totalMinor } = await placed({ priceMinor: 2_000_000_000, quantity: 2 });
    expect(totalMinor).toBeGreaterThan(2_147_483_647);

    await openSession(app, token, orderId).expect(201);

    expect(gateway.lastCreateSessionInput()?.amountMinor).toBe(totalMinor);
    expect(await readPayment(app, orderId)).toMatchObject({ amountMinor: totalMinor });
  });
});
