import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SagaKickExecutor } from '../../src/modules/order/application/saga/saga-kick.executor';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { deliverDomainEventsOnce } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readReservationOrder,
  readSaga,
  readStock,
  seedSellableSku,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_cancel_secret_01';
const ON_HAND = 10;
const QUANTITY = 2;

describe('Checkout saga, cancel (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  const cancel = (token: string, orderId: string) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(authHeader(token));
  const adminCancel = (token: string, orderId: string) =>
    request(app.getHttpServer()).post(`/admin/orders/${orderId}/cancel`).set(authHeader(token));

  const cancelledEvents = (orderId: string) =>
    db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.aggregateId, orderId), eq(schema.outbox.eventType, 'order.cancelled')));

  /** The cancel awaits its compensation, so all of it is visible the moment the answer is. */
  async function expectCompensated(order: OpenOrder, reason: string): Promise<void> {
    expect(await readOrder(app, order.orderId)).toMatchObject({ status: 'CANCELLED', finalizeReason: reason });
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(gateway.wasExpired(order.sessionId)).toBe(true);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    expect((await cancelledEvents(order.orderId)).map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ orderId: order.orderId, reason }),
    ]);
  }

  it("compensates a pending order before answering the buyer's cancel, with no runner tick", async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);

    await cancel(order.token, order.orderId).expect(200);

    await expectCompensated(order, 'user:cancel');
    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });

  it('compensates through the same path when an admin cancels', async () => {
    const { accessToken: admin } = await createTestAdminPrincipal(app);
    const order = await placeAndOpenSession(app, sku, QUANTITY);

    await adminCancel(admin, order.orderId).expect(200);

    await expectCompensated(order, 'admin:cancel');
  });

  it('refuses to cancel an order whose payment is being captured, and lets the capture finish', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const intentId = gateway.authorize(order.sessionId);
    const capture = gateway.hangCapture(intentId);
    await postAuthorizationWebhook(app, gateway, order);

    try {
      await deliverDomainEventsOnce(app);
      await capture.entered;
      expect((await readOrder(app, order.orderId)).status).toBe('CONFIRMING');

      const refused = await cancel(order.token, order.orderId).expect(409);

      expect(refused.body.message).toBe('Order cannot be cancelled in status CONFIRMING');
    } finally {
      capture.release();
      await app.get(SagaKickExecutor).drain();
    }
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(gateway.wasVoided(intentId)).toBe(false);
    expect(await cancelledEvents(order.orderId)).toEqual([]);
  });
});
