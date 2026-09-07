import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// A syntactically-valid UUID that no fixture creates — probes 404 paths (unknown
// order id) without a text→uuid cast 500.
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

// Black-box HTTP tests for the Order context over real Postgres + Redis. Proves the senior-signal
// behaviors: POST /orders is the ATOMIC CHECKOUT — snapshot the cart, hold stock, and go PENDING in
// one transaction (price is FROZEN, the transactional source of truth), and per-user isolation.
// Cart, Catalog, and Inventory are reached only through their published ports.
describe('Order (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const server = () => app.getHttpServer();

  async function newUser(): Promise<string> {
    const { accessToken } = await createTestUser(app);
    return accessToken;
  }

  async function addToCart(token: string, skuId: string, quantity: number): Promise<void> {
    await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity }).expect(200);
  }

  // Repriced directly in the DB (mirrors the fixtures) to exercise the snapshot
  // invariant: a Catalog price change must NOT move a created order's total.
  async function repriceSku(variantId: string, amountMinor: number): Promise<void> {
    await db.update(schema.prices).set({ amountMinor }).where(eq(schema.prices.variantId, variantId));
  }

  async function archiveProduct(productId: string): Promise<void> {
    await db.update(schema.products).set({ status: 'ARCHIVED' }).where(eq(schema.products.id, productId));
  }

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
      const token = await newUser();
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 50_000 });
      await seedStock(app, a.variantId, 5);
      await seedStock(app, b.variantId, 5);
      await addToCart(token, a.variantId, 2);
      await addToCart(token, b.variantId, 1);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING'); // one-step checkout: straight to PENDING, no DRAFT
      expect(res.body.currency).toBe('VND');
      expect(res.body.placedAt).not.toBeNull();
      expect(res.body.items).toHaveLength(2);
      expect(res.body.totalAmountMinor).toBe(199_000 * 2 + 50_000); // 448_000
      const lineA = res.body.items.find((i: { skuId: string }) => i.skuId === a.variantId);
      expect(lineA).toMatchObject({
        skuId: a.variantId,
        quantity: 2,
        unitPriceMinor: 199_000,
        lineTotalMinor: 398_000,
      });
    });

    it('rejects checkout from an empty cart with 400', async () => {
      const token = await newUser();

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(400);
    });

    it('rejects checkout when a cart line is an archived/inactive SKU (400)', async () => {
      const token = await newUser();
      const { productId, variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await addToCart(token, variantId, 1);

      await archiveProduct(productId); // product becomes non-sellable after it was carted

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(400);
    });

    it('handles an order total that exceeds int32 without a 500 (bigint total)', async () => {
      const token = await newUser();
      // Two lines each fit int32 (199_000 × 10_000 = 1.99e9) but the sum (3.98e9)
      // exceeds int32 max — an int4 total column would 500 here.
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 199_000 });
      await seedStock(app, a.variantId, 10_000);
      await seedStock(app, b.variantId, 10_000);
      await addToCart(token, a.variantId, 10_000);
      await addToCart(token, b.variantId, 10_000);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(201);
      expect(res.body.totalAmountMinor).toBe(3_980_000_000);
    });

    it('leaves the cart intact after checkout (cart is cleared later, at PAID)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(token, variantId, 2);

      await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);

      const cart = await request(server()).get('/cart').set(authHeader(token));
      expect(cart.status).toBe(200);
      expect(cart.body.items).toHaveLength(1);
      expect(cart.body.items[0].quantity).toBe(2);
    });
  });

  describe('GET /orders and /orders/:id', () => {
    it('returns a checked-out order by id', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(token, variantId, 3);
      const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
      const orderId = created.body.id;

      const res = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderId);
      expect(res.body.totalAmountMinor).toBe(300_000);
    });

    it('lists the user orders', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(token, variantId, 1);
      await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);

      const res = await request(server()).get('/orders').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
      expect(res.body.items).toHaveLength(1);
    });

    it('returns 404 for an unknown order id', async () => {
      const token = await newUser();

      const res = await request(server()).get(`/orders/${ABSENT_UUID}`).set(authHeader(token));

      expect(res.status).toBe(404);
    });
  });

  describe('order is the source of truth (price is frozen at checkout)', () => {
    it('keeps the total unchanged when Catalog reprices after the order is created', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(token, variantId, 2);
      const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
      const orderId = created.body.id;
      expect(created.body.totalAmountMinor).toBe(200_000);

      await repriceSku(variantId, 150_000); // Catalog price changes AFTER the order exists

      const res = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items[0].unitPriceMinor).toBe(100_000); // frozen, not the new 150_000
      expect(res.body.totalAmountMinor).toBe(200_000); // total is stable
    });
  });

  describe('per-user isolation', () => {
    it("does not expose another user's order", async () => {
      const tokenA = await newUser();
      const tokenB = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(tokenA, variantId, 1);
      const created = await request(server()).post('/orders').set(authHeader(tokenA)).set(idempotencyKeyHeader());
      const orderId = created.body.id;

      const getByB = await request(server()).get(`/orders/${orderId}`).set(authHeader(tokenB));
      const listB = await request(server()).get('/orders').set(authHeader(tokenB));

      expect(getByB.status).toBe(404);
      expect(listB.body.items).toEqual([]);
    });
  });
});
