import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { CircuitBreakerFactory } from '@jcool/platform/resilience';
import { PAYMENT_GATEWAY_BREAKER } from '../../src/modules/payment/infrastructure/gateway/breaker-payment-gateway.adapter';
import { MAX_PENDING_ORDERS_PER_USER } from '../../src/modules/order/order.constants';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { computeRequestHash } from '../../src/shared/idempotency';
import { authHeader } from '../setup/bearer.helper';
import { buyerWithCart, checkout, openSession, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal, createTestPrincipal, newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';

// Status codes and body shapes of the checkout routes as clients see them. Nothing here may change when
// the code behind these routes does.

const ORDER_KEYS = ['currency', 'id', 'items', 'placedAt', 'status', 'totalAmountMinor'];
const ORDER_ITEM_KEYS = ['lineTotalMinor', 'productName', 'quantity', 'skuId', 'unitPriceMinor'];
const PAGE_KEYS = ['items', 'page', 'pageSize', 'total', 'totalPages'];
const SESSION_KEYS = ['clientSecret', 'paymentId', 'providerSessionId', 'redirectUrl'];

function expectOrderShape(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(ORDER_KEYS);
  expect(body.id).toMatch(/^\d+$/);
  expect(typeof body.currency).toBe('string');
  expect(Number.isInteger(body.totalAmountMinor)).toBe(true);
  for (const item of body.items as Record<string, unknown>[]) {
    expect(Object.keys(item).sort()).toEqual(ORDER_ITEM_KEYS);
  }
}

describe('Checkout HTTP contract (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();
  const cancel = (token: string, orderId: string) =>
    request(server()).post(`/orders/${orderId}/cancel`).set(authHeader(token));

  async function placedOrder(quantity = 2): Promise<{ token: string; body: Record<string, unknown> }> {
    const sku = await seedSellableSku(app, { onHand: 10, priceMinor: 120_000 });
    const token = await buyerWithCart(app, sku.variantId, quantity);
    const res = await checkout(app, token).expect(201);
    return { token, body: res.body as Record<string, unknown> };
  }

  describe('POST /orders', () => {
    it('answers 201 with the placed order', async () => {
      const sku = await seedSellableSku(app, { onHand: 10, priceMinor: 120_000 });
      const token = await buyerWithCart(app, sku.variantId, 2);

      const res = await checkout(app, token).expect(201);

      expectOrderShape(res.body);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        currency: 'VND',
        totalAmountMinor: 240_000,
        items: [{ skuId: sku.variantId, unitPriceMinor: 120_000, quantity: 2, lineTotalMinor: 240_000 }],
      });
      expect(new Date(res.body.placedAt as string).toISOString()).toBe(res.body.placedAt);
    });

    it('answers 400 to an empty cart', async () => {
      const token = await newPrincipalToken(app);

      const res = await checkout(app, token).expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, message: 'Cart is empty' });
    });

    it('answers 409 to a stock shortfall without revealing what is left', async () => {
      const sku = await seedSellableSku(app, { onHand: 1 });
      const token = await buyerWithCart(app, sku.variantId, 2);

      const res = await checkout(app, token).expect(409);

      expect(res.body).toMatchObject({ statusCode: 409, message: 'Insufficient stock' });
    });

    it('answers 409 past the pending-order cap', async () => {
      const sku = await seedSellableSku(app, { onHand: 10 });
      const token = await buyerWithCart(app, sku.variantId, 1);
      for (let i = 0; i < MAX_PENDING_ORDERS_PER_USER; i++) {
        await checkout(app, token).expect(201);
      }

      const res = await checkout(app, token).expect(409);

      expect(res.body.message).toMatch(/^Too many pending orders \(max 3\)/);
    });

    it('answers 422 to a key reused with a different body', async () => {
      const sku = await seedSellableSku(app, { onHand: 10 });
      const token = await buyerWithCart(app, sku.variantId, 1);
      const key = randomUUID();
      await checkout(app, token).set(idempotencyKeyHeader(key)).expect(201);

      const res = await checkout(app, token).set(idempotencyKeyHeader(key)).send({ changed: true }).expect(422);

      expect(res.body.message).toBe('Idempotency-Key was reused with a different request');
    });

    it('answers 409 while a request under the same key is still in progress', async () => {
      const { user, accessToken } = await createTestPrincipal(app);
      const key = randomUUID();
      const scope = `user:${user.id}`;
      await db.insert(schema.idempotencyKeys).values({
        id: testId(),
        scope,
        key,
        requestHash: computeRequestHash('POST', '/orders', scope, {}),
        status: 'IN_PROGRESS',
        method: 'POST',
        path: '/orders',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const res = await checkout(app, accessToken).set(idempotencyKeyHeader(key)).send({}).expect(409);

      expect(res.body.message).toBe('A request with this Idempotency-Key is already in progress');
    });
  });

  describe('POST /orders/:id/pay', () => {
    it('answers 201 with the session to send the buyer to', async () => {
      const { token, body } = await placedOrder();

      const res = await openSession(app, token, body.id as string).expect(201);

      expect(SESSION_KEYS).toEqual(expect.arrayContaining(Object.keys(res.body)));
      expect(res.body.paymentId).toMatch(/^\d+$/);
      expect(typeof res.body.providerSessionId).toBe('string');
      expect(typeof res.body.redirectUrl).toBe('string');
    });

    it("answers 404 to someone else's order", async () => {
      const { body } = await placedOrder();
      const stranger = await newPrincipalToken(app);

      await openSession(app, stranger, body.id as string).expect(404);
    });

    it('answers 409 once the order is no longer pending', async () => {
      const { token, body } = await placedOrder();
      await cancel(token, body.id as string).expect(200);

      await openSession(app, token, body.id as string).expect(409);
    });
  });

  describe('POST /orders/:id/cancel', () => {
    it('answers 200 with the cancelled order, and 200 again on a repeat', async () => {
      const { token, body } = await placedOrder();

      const first = await cancel(token, body.id as string).expect(200);
      const again = await cancel(token, body.id as string).expect(200);

      expectOrderShape(first.body);
      expect(first.body).toEqual({ ...body, status: 'CANCELLED' });
      expect(again.body).toEqual(first.body);
    });

    it('answers 409 once the order has settled', async () => {
      const { token, body } = await placedOrder();
      await db
        .update(schema.orders)
        .set({ status: 'PAID', finalizedAt: new Date() })
        .where(eq(schema.orders.id, body.id as string));

      await cancel(token, body.id as string).expect(409);
    });

    it("answers 404 to someone else's order", async () => {
      const { body } = await placedOrder();
      const stranger = await newPrincipalToken(app);

      await cancel(stranger, body.id as string).expect(404);
    });

    it('lets an admin cancel through the same contract', async () => {
      const { body } = await placedOrder();
      const admin = await createTestAdminPrincipal(app);

      const res = await request(server())
        .post(`/admin/orders/${body.id as string}/cancel`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body).toEqual({ ...body, status: 'CANCELLED' });
    });
  });

  describe('GET /orders', () => {
    it('lists and reads back the placed order in the same shape checkout answered with', async () => {
      const { token, body } = await placedOrder();

      const list = await request(server()).get('/orders').set(authHeader(token)).expect(200);
      const one = await request(server())
        .get(`/orders/${body.id as string}`)
        .set(authHeader(token))
        .expect(200);

      expect(Object.keys(list.body).sort()).toEqual(PAGE_KEYS);
      expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
      expect(list.body.items).toEqual([body]);
      expect(one.body).toEqual(body);
    });
  });
});

describe('Checkout HTTP contract while the payment gateway circuit is open (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({
      BREAKER_ENABLED: 'true',
      BREAKER_VOLUME_THRESHOLD: '2',
      BREAKER_ERROR_THRESHOLD_PCT: '50',
      BREAKER_RESET_TIMEOUT_MS: '60000',
      BREAKER_ROLLING_WINDOW_MS: '10000',
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('answers 502 to pay', async () => {
    const sku = await seedSellableSku(app, { onHand: 3 });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    const breaker = app.get(CircuitBreakerFactory).create(PAYMENT_GATEWAY_BREAKER);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(breaker.run(() => Promise.reject(new Error('gateway down')))).rejects.toThrow('gateway down');
    }

    const res = await openSession(app, token, orderId).expect(502);

    expect(res.body.statusCode).toBe(502);
  });
});
