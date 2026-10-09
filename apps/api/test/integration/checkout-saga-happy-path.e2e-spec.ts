import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKOUT_SAGA_SETTINGS,
  type CheckoutSagaSettings,
} from '../../src/modules/order/application/saga/checkout-saga.settings';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import {
  auditLedgerInvariants,
  authorizeAndRelay,
  placeAndOpenSession,
  readOrder,
  readPayment,
  readPaymentOrder,
  readReservationOrder,
  readSaga,
  readStock,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_happy_path_01';

describe('Checkout saga, happy path (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('parks a placed order on its payment deadline, holding stock past it, behind a session that dies with it', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });

    const order = await placeAndOpenSession(app, sku, 2);

    const saga = await readSaga(app, order.orderId);
    const { holdSafetyMs } = app.get<CheckoutSagaSettings>(CHECKOUT_SAGA_SETTINGS);
    expect((await readOrder(app, order.orderId)).status).toBe('PENDING');
    expect(saga).toMatchObject({ step: 'AWAITING_AUTH', leaseUntil: null, pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({
      status: 'HELD',
      holdUntil: new Date(saga.deadlineAt.getTime() + holdSafetyMs),
    });
    expect(gateway.sessionRequest(order.sessionId)).toMatchObject({
      captureMethod: 'manual',
      expiresAt: saga.deadlineAt,
    });
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 5, quantityReserved: 2 });
  });

  it('takes an authorized order to PAID, committing stock before taking the money exactly once', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const order = await placeAndOpenSession(app, sku, 2);

    const { intentId, drained } = await authorizeAndRelay(app, gateway, order);

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readSaga(app, order.orderId)).step).toBe('COMPLETED');
    expect((await readPayment(app, order.orderId)).status).toBe('SUCCEEDED');
    expect((await readReservationOrder(app, order.orderId)).status).toBe('COMMITTED');
    expect((await readPaymentOrder(app, order.orderId)).status).toBe('CAPTURED');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 3, quantityReserved: 0 });
    // The confirmation mail is the order.paid consumer, so its delivery is the mail effect running.
    expect(drained.map(({ eventType, result }) => [eventType, result])).toEqual(
      expect.arrayContaining([
        ['payment.authorized', 'processed'],
        ['order.paid', 'processed'],
      ]),
    );
    await expect(auditLedgerInvariants(app, { [sku.variantId]: 5 })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });
});
