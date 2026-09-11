import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { archiveProduct, createTestProduct, repriceSku } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newUserToken } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// A syntactically-valid UUID that no fixture creates — probes 404 paths (unknown
// order id) without a text→uuid cast 500.
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

// Black-box HTTP tests for the Order context over real Postgres + Redis. POST /orders is the atomic
// checkout: snapshot the cart, hold stock, and go PENDING in one transaction, freezing the price as
// the transactional source of truth. Cart, Catalog, and Inventory are reached only through ports.
describe('Order (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  describe('auth', () => {
    it('rejects an unauthenticated POST /orders with 401', async () => {
      const res = await request(server()).post('/orders');
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated GET /orders with 401', async () => {
      const res = await request(server()).get('/orders');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /orders (atomic checkout)', () => {
    it('checks out the cart into a PENDING order (201, frozen unit price, total = Σ unit×qty, placedAt set)', async () => {
      const token = await newUserToken(app);
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 50_000 });
      await seedStock(app, a.variantId, 5);
      await seedStock(app, b.variantId, 5);
      await addToCart(app, token, a.variantId, 2);
      await addToCart(app, token, b.variantId, 1);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING'); // one-step checkout: straight to PENDING, no DRAFT
      expect(res.body.currency).toBe('VND');
      expect(res.body.placedAt).not.toBeNull();
      expect(res.body.items).toHaveLength(2);
      expect(res.body.totalAmountMinor).toBe(199_000 * 2 + 50_000);
      const lineA = res.body.items.find((i: { skuId: string }) => i.skuId === a.variantId);
      expect(lineA).toMatchObject({
        skuId: a.variantId,
        quantity: 2,
        unitPriceMinor: 199_000,
        lineTotalMinor: 398_000,
      });
    });

    it('rejects checkout from an empty cart with 400', async () => {
      const token = await newUserToken(app);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(400);
    });

    it('rejects checkout when a cart line is an archived/inactive SKU (400)', async () => {
      const token = await newUserToken(app);
      const { productId, variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await addToCart(app, token, variantId, 1);

      await archiveProduct(app, productId);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(400);
    });

    it('handles an order total that exceeds int32 without a 500 (bigint total)', async () => {
      const token = await newUserToken(app);
      // Two lines each fit int32 (199_000 × 10_000 = 1.99e9) but the sum (3.98e9)
      // exceeds int32 max — an int4 total column would 500 here.
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 199_000 });
      await seedStock(app, a.variantId, 10_000);
      await seedStock(app, b.variantId, 10_000);
      await addToCart(app, token, a.variantId, 10_000);
      await addToCart(app, token, b.variantId, 10_000);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(201);
      expect(res.body.totalAmountMinor).toBe(3_980_000_000);
    });

    it('leaves the cart intact after checkout (cart is cleared later, at PAID)', async () => {
      const token = await newUserToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, token, variantId, 2);

      await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);

      const cart = await request(server()).get('/cart').set(authHeader(token));
      expect(cart.status).toBe(200);
      expect(cart.body.items).toHaveLength(1);
      expect(cart.body.items[0].quantity).toBe(2);
    });
  });

  describe('GET /orders and /orders/:id', () => {
    it('returns a checked-out order by id', async () => {
      const token = await newUserToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, token, variantId, 3);
      const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
      const orderId = created.body.id;

      const res = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderId);
      expect(res.body.totalAmountMinor).toBe(300_000);
    });

    it('lists the user orders', async () => {
      const token = await newUserToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, token, variantId, 1);
      await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);

      const res = await request(server()).get('/orders').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
      expect(res.body.items).toHaveLength(1);
    });

    it('returns 404 for an unknown order id', async () => {
      const token = await newUserToken(app);

      const res = await request(server()).get(`/orders/${ABSENT_UUID}`).set(authHeader(token));

      expect(res.status).toBe(404);
    });
  });

  describe('order is the source of truth (price is frozen at checkout)', () => {
    it('keeps the total unchanged when Catalog reprices after the order is created', async () => {
      const token = await newUserToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, token, variantId, 2);
      const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
      const orderId = created.body.id;
      expect(created.body.totalAmountMinor).toBe(200_000);

      await repriceSku(app, variantId, 150_000); // Catalog price changes AFTER the order exists

      const res = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items[0].unitPriceMinor).toBe(100_000); // frozen, not the new 150_000
      expect(res.body.totalAmountMinor).toBe(200_000);
    });
  });

  describe('per-user isolation', () => {
    it("does not expose another user's order", async () => {
      const tokenA = await newUserToken(app);
      const tokenB = await newUserToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, tokenA, variantId, 1);
      const created = await request(server()).post('/orders').set(authHeader(tokenA)).set(idempotencyKeyHeader());
      const orderId = created.body.id;

      const getByB = await request(server()).get(`/orders/${orderId}`).set(authHeader(tokenB));
      const listB = await request(server()).get('/orders').set(authHeader(tokenB));

      expect(getByB.status).toBe(404);
      expect(listB.body.items).toEqual([]);
    });
  });
});
