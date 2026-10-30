import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { authHeader } from '../setup/bearer.helper';
import {
  buyerWithCart,
  checkout,
  driveToPaid,
  readOrder,
  readStock,
  seedSellableSku,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const STOCK = 10;
const QUANTITY = 2;
const ABSENT_ID = testId();

// The buyer's side of the route. What the saga does with an open payment session on cancel is
// checkout-saga-cancel's subject.
describe('Order cancel (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  const server = () => app.getHttpServer();

  function cancel(token: string, orderId: string): request.Test {
    return request(server()).post(`/orders/${orderId}/cancel`).set(authHeader(token));
  }

  describe('POST /orders/:id/cancel', () => {
    it('cancels a pending order and gives the stock back before answering', async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const placed = await checkout(app, token).expect(201);
      const orderId = placed.body.id as string;
      expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);

      const res = await cancel(token, orderId).expect(200);

      expect(res.body).toMatchObject({ id: orderId, status: OrderStatus.CANCELLED });
      const order = await readOrder(app, orderId);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.finalizeReason).toBe('user:cancel');
      const stock = await readStock(app, sku.variantId);
      expect(stock.quantityReserved).toBe(0);
      expect(stock.quantityOnHand).toBe(STOCK); // released, not sold
    });

    // A client that lost the first response must be able to retry without being told it did
    // something wrong.
    it('answers a repeated cancel the same way, releasing the stock only once', async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      await cancel(token, orderId).expect(200);
      const afterFirst = await readStock(app, sku.variantId);

      await cancel(token, orderId).expect(200);

      expect(await readStock(app, sku.variantId)).toMatchObject({
        quantityOnHand: afterFirst.quantityOnHand,
        quantityReserved: afterFirst.quantityReserved,
      });
      const events = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId));
      expect(events.filter((e) => e.eventType === 'order.cancelled')).toHaveLength(1);
    });

    it('refuses to cancel an order the buyer has already paid for', async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      await driveToPaid(app, token, orderId);

      // 409, not 200: unwinding a payment is a refund, which this shop does not do.
      await cancel(token, orderId).expect(409);
      expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PAID);
    });

    // 404 rather than 403, so the endpoint cannot be used to discover which order ids are real.
    it("hides someone else's order behind the same 404 as an id that does not exist", async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      const { accessToken: stranger } = await createTestPrincipal(app);

      await cancel(stranger, orderId).expect(404);
      await cancel(stranger, ABSENT_ID).expect(404);

      expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);
    });
  });
});
