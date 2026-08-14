import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// A syntactically-valid UUID that no fixture creates — used to probe 404 paths
// (unknown SKU on add, absent line on patch) without a text→uuid cast 500.
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

// Black-box HTTP tests for the Cart context over real Postgres + Redis. Proves
// the senior-signal behaviors: upsert accumulation, per-user isolation, and a
// subtotal built from LIVE Catalog prices (cart never freezes a price) — read
// only through Catalog's published port.
describe('Cart (integration, real Postgres + Redis)', () => {
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

  // Directly repriced in the DB (mirrors the fixtures) to exercise "cart reflects
  // the new price" without going through the admin write API.
  async function repriceSku(variantId: string, amountMinor: number): Promise<void> {
    await db.update(schema.prices).set({ amountMinor }).where(eq(schema.prices.variantId, variantId));
  }

  async function archiveProduct(productId: string): Promise<void> {
    await db.update(schema.products).set({ status: 'ARCHIVED' }).where(eq(schema.products.id, productId));
  }

  describe('auth', () => {
    it('rejects an unauthenticated GET /cart with 401', async () => {
      const res = await request(server()).get('/cart');
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated POST /cart/items with 401', async () => {
      const res = await request(server()).post('/cart/items').send({ skuId: ABSENT_UUID, quantity: 1 });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /cart', () => {
    it('auto-creates an empty cart on first read (200, items [], subtotal 0)', async () => {
      const token = await newUser();

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.subtotalMinor).toBe(0);
    });

    it('sums the subtotal from live prices across lines', async () => {
      const token = await newUser();
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 50_000 });

      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: a.variantId, quantity: 2 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: b.variantId, quantity: 1 });

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.subtotalMinor).toBe(199_000 * 2 + 50_000); // 448_000
      expect(res.body.currency).toBe('VND');
    });
  });

  describe('POST /cart/items', () => {
    it('adds a SKU to an empty cart (200, one line with the right quantity + live price)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 199_000 });

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: variantId, quantity: 2 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        skuId: variantId,
        quantity: 2,
        unitPriceMinor: 199_000,
        lineTotalMinor: 398_000,
        isActive: true,
      });
      expect(res.body.subtotalMinor).toBe(398_000);
    });

    it('accumulates quantity on a repeat SKU instead of adding a second line', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });

      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 2 });
      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: variantId, quantity: 3 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].quantity).toBe(5);
      expect(res.body.subtotalMinor).toBe(500_000);
    });

    it('rejects quantity = 0 with 400 (DTO validation)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app);

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: variantId, quantity: 0 });

      expect(res.status).toBe(400);
    });

    it('rejects a negative quantity with 400 (DTO validation)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app);

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: variantId, quantity: -3 });

      expect(res.status).toBe(400);
    });

    it('rejects a quantity above the per-line cap with 400, not a 500 (int4 overflow guard)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app);

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: variantId, quantity: 3_000_000_000 }); // > int4 max, would 500 unguarded

      expect(res.status).toBe(400);
    });

    it('returns 404 when the SKU does not exist in Catalog', async () => {
      const token = await newUser();

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: ABSENT_UUID, quantity: 1 });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /cart/items/:skuId', () => {
    it('sets a line to an absolute quantity (200)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 2 });

      const res = await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: 5 });

      expect(res.status).toBe(200);
      expect(res.body.items[0].quantity).toBe(5);
      expect(res.body.subtotalMinor).toBe(500_000);
    });

    it('returns 404 when the SKU is not in the cart', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app); // created but never added

      const res = await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: 3 });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /cart/items/:skuId', () => {
    it('removes one line from the cart (200)', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app);
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 1 });

      const res = await request(server()).delete(`/cart/items/${variantId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('is idempotent — deleting an absent line still returns 200', async () => {
      const token = await newUser();

      const res = await request(server()).delete(`/cart/items/${ABSENT_UUID}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe('DELETE /cart', () => {
    it('clears every line (200, empty cart)', async () => {
      const token = await newUser();
      const a = await createTestProduct(app);
      const b = await createTestProduct(app);
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: a.variantId, quantity: 1 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: b.variantId, quantity: 1 });

      const res = await request(server()).delete('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.subtotalMinor).toBe(0);
    });
  });

  describe('cart is scratch space (live price, not frozen)', () => {
    it('reflects a Catalog price change on the next read', async () => {
      const token = await newUser();
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 2 });

      await repriceSku(variantId, 150_000); // price changes in Catalog after the add

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items[0].unitPriceMinor).toBe(150_000); // live, not the 100_000 at add time
      expect(res.body.subtotalMinor).toBe(300_000);
    });

    it('keeps an archived-after-add line in the subtotal, flagged isActive:false', async () => {
      const token = await newUser();
      const { productId, variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 2 });

      await archiveProduct(productId); // product archived after it was added

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].isActive).toBe(false); // signalled unavailable...
      expect(res.body.subtotalMinor).toBe(200_000); // ...but still counted (gross of availability)
    });
  });

  describe('per-user isolation', () => {
    it("does not leak one user's items into another user's cart", async () => {
      const tokenA = await newUser();
      const tokenB = await newUser();
      const { variantId } = await createTestProduct(app);
      await request(server()).post('/cart/items').set(authHeader(tokenA)).send({ skuId: variantId, quantity: 1 });

      const resA = await request(server()).get('/cart').set(authHeader(tokenA));
      const resB = await request(server()).get('/cart').set(authHeader(tokenB));

      expect(resA.body.items).toHaveLength(1);
      expect(resB.body.items).toEqual([]); // user B sees an empty cart
    });
  });
});
