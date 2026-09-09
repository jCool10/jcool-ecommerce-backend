import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { authHeader } from '../setup/auth.helper';
import { buyerWithCart, checkout, readOrder, readStock, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestAdmin, createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const STOCK = 40;
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The operator's order surface: unscoped reads, a filtered list, and a force-cancel that goes
 * through exactly the same settlement a buyer's own cancel does. The list is paginated, which is
 * the point of it — an admin listing every order is the one read that grows without bound.
 */
describe('Admin orders (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let variantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    adminToken = (await createTestAdmin(app)).accessToken;
    variantId = (await seedSellableSku(app, { onHand: STOCK })).variantId;
  });

  const server = () => app.getHttpServer();

  const asAdmin = (path: string): request.Test => request(server()).get(path).set(authHeader(adminToken));

  /** Returns the buyer's userId as well, so a test can exercise the user-scoped filter. */
  async function placeOrder(quantity = 1): Promise<{ token: string; orderId: string; userId: string }> {
    const token = await buyerWithCart(app, variantId, quantity);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    const userId = (await readOrder(app, orderId)).userId;
    return { token, orderId, userId };
  }

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await request(server()).get('/admin/orders').expect(401);
    });

    // 403, not 404: the caller is authenticated, so hiding the route buys nothing and costs clarity.
    it('rejects a signed-in non-admin with 403', async () => {
      const { accessToken } = await createTestUser(app);
      await request(server()).get('/admin/orders').set(authHeader(accessToken)).expect(403);
      await request(server()).post(`/admin/orders/${ABSENT_UUID}/cancel`).set(authHeader(accessToken)).expect(403);
    });
  });

  describe('GET /admin/orders', () => {
    it('lists every buyer’s orders, newest first, in a counted envelope', async () => {
      const first = await placeOrder();
      const second = await placeOrder();

      const res = await asAdmin('/admin/orders').expect(200);

      expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20, totalPages: 1 });
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([second.orderId, first.orderId]);
    });

    it('pages, and reports a total that describes the whole result rather than the page', async () => {
      for (let i = 0; i < 3; i++) await placeOrder();

      const page1 = await asAdmin('/admin/orders?page=1&pageSize=2').expect(200);
      const page2 = await asAdmin('/admin/orders?page=2&pageSize=2').expect(200);

      expect(page1.body).toMatchObject({ total: 3, page: 1, pageSize: 2, totalPages: 2 });
      expect(page1.body.items).toHaveLength(2);
      expect(page2.body).toMatchObject({ total: 3, page: 2, totalPages: 2 });
      expect(page2.body.items).toHaveLength(1);
      // Disjoint pages: an unstable sort would repeat or drop rows across the boundary.
      const ids = [...page1.body.items, ...page2.body.items].map((o: { id: string }) => o.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('filters by status and by buyer', async () => {
      const kept = await placeOrder();
      const cancelled = await placeOrder();
      await request(server()).post(`/admin/orders/${cancelled.orderId}/cancel`).set(authHeader(adminToken)).expect(200);

      const pending = await asAdmin(`/admin/orders?status=${OrderStatus.PENDING}`).expect(200);
      expect(pending.body.items.map((o: { id: string }) => o.id)).toEqual([kept.orderId]);

      const mine = await asAdmin(`/admin/orders?userId=${kept.userId}`).expect(200);
      expect(mine.body).toMatchObject({ total: 1 });
      expect(mine.body.items[0].id).toBe(kept.orderId);
    });

    it('rejects a status or page the query contract does not allow', async () => {
      await asAdmin('/admin/orders?status=SHIPPED').expect(400);
      await asAdmin('/admin/orders?pageSize=500').expect(400);
      await asAdmin('/admin/orders?userId=not-a-uuid').expect(400);
    });
  });

  describe('GET /admin/orders/:id', () => {
    it('reads any buyer’s order without being that buyer', async () => {
      const { orderId } = await placeOrder(2);

      const res = await asAdmin(`/admin/orders/${orderId}`).expect(200);

      expect(res.body).toMatchObject({ id: orderId, status: OrderStatus.PENDING });
      expect(res.body.items).toHaveLength(1);
    });

    it('answers 404 for an order that does not exist', async () => {
      await asAdmin(`/admin/orders/${ABSENT_UUID}`).expect(404);
    });
  });

  describe('POST /admin/orders/:id/cancel', () => {
    it('force-cancels a buyer’s order and releases its stock, stamped as an admin action', async () => {
      const { orderId } = await placeOrder(3);

      const res = await request(server())
        .post(`/admin/orders/${orderId}/cancel`)
        .set(authHeader(adminToken))
        .expect(200);

      expect(res.body).toMatchObject({ id: orderId, status: OrderStatus.CANCELLED });
      const order = await readOrder(app, orderId);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      // The one thing that differs from a buyer's own cancel — same settlement, different audit.
      expect(order.finalizeReason).toBe('admin:cancel');
      expect((await readStock(app, variantId)).quantityReserved).toBe(0);
    });

    it('answers 404 for an order that does not exist', async () => {
      await request(server()).post(`/admin/orders/${ABSENT_UUID}/cancel`).set(authHeader(adminToken)).expect(404);
    });
  });
});
