import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import {
  authorizeAndRelay,
  buyerWithCart,
  checkout,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readPayment,
  readStock,
  seedSellableSku,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const WEBHOOK_SECRET = 'whsec_e2e_order_cancel_secret_01234';
const STOCK = 10;
const QUANTITY = 2;
const ABSENT_ID = testId();

describe('Order cancel (integration, real Postgres + Redis)', () => {
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
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  const cancel = (token: string, orderId: string) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(authHeader(token));

  describe('POST /orders/:id/cancel', () => {
    it('cancels a pending order and gives the stock back before answering', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);

      const res = await cancel(order.token, order.orderId).expect(200);

      expect(res.body).toMatchObject({ id: order.orderId, status: OrderStatus.CANCELLED });
      const cancelled = await readOrder(app, order.orderId);
      expect(cancelled).toMatchObject({ status: OrderStatus.CANCELLED, finalizeReason: 'user:cancel' });
      expect(cancelled.finalizedAt).toBeInstanceOf(Date);
      // Released, not sold.
      expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
    });

    // A client that lost the first response must be able to retry without being told it did
    // something wrong.
    it('answers a repeated cancel the same way, releasing the stock only once', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      const first = await cancel(order.token, order.orderId).expect(200);

      const second = await cancel(order.token, order.orderId).expect(200);

      expect(second.body).toEqual(first.body);
      expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
      const events = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, order.orderId));
      expect(events.filter((e) => e.eventType === 'order.cancelled')).toHaveLength(1);
    });

    it('refuses to cancel an order the buyer has already paid for', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await authorizeAndRelay(app, gateway, order);

      // 409, not 200: unwinding a payment is a refund, which this shop does not do.
      await cancel(order.token, order.orderId).expect(409);

      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PAID);
    });

    // 404 rather than 403, so the endpoint cannot be used to discover which order ids are real.
    it("hides someone else's order behind the same 404 as an id that does not exist", async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      const { accessToken: stranger } = await createTestPrincipal(app);

      await cancel(stranger, order.orderId).expect(404);
      await cancel(stranger, ABSENT_ID).expect(404);

      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PENDING);
    });

    it('hides a rejected checkout from its own buyer behind the same 404', async () => {
      const lastUnit = await seedSellableSku(app, { onHand: 1 });
      const token = await buyerWithCart(app, lastUnit.variantId, 2);
      await checkout(app, token).expect(409);
      const [{ id: orderId }] = await db.select({ id: schema.orders.id }).from(schema.orders);

      await cancel(token, orderId).expect(404);

      expect((await readOrder(app, orderId)).status).toBe(OrderStatus.REJECTED);
    });
  });

  // The race the cancel button makes routine: the buyer presses cancel with the hosted page still
  // open in another tab, and pays on it. The stock is already released; the money is only held.
  describe('cancel racing a payment that has already gone through', () => {
    it('voids the hold instead of taking the money, however late its webhook lands', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      const intentId = gateway.authorize(order.sessionId);

      await cancel(order.token, order.orderId).expect(200);
      await postAuthorizationWebhook(app, gateway, order);
      await drainDomainEvents(app);

      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.CANCELLED);
      expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.VOIDED);
      expect(gateway.wasVoided(intentId)).toBe(true);
      expect(gateway.captureCalls(intentId)).toBe(0);
      expect((await readStock(app, sku.variantId)).quantityReserved).toBe(0);
    });
  });
});
