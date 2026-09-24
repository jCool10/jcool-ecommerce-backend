import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct, repriceSku } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal, newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('Order (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  describe('POST /orders', () => {
    it('checks out the cart into a PENDING order at frozen unit prices', async () => {
      const token = await newPrincipalToken(app);
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 50_000 });
      await seedStock(app, a.variantId, 5);
      await seedStock(app, b.variantId, 5);
      await addToCart(app, token, a.variantId, 2);
      await addToCart(app, token, b.variantId, 1);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');
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

    // The owner id is past 2^53, so a Number() on the way into Postgres would drop digits.
    it("keeps every digit of the caller's id on the cart and the order it becomes", async () => {
      const { user, accessToken } = await createTestPrincipal(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await seedStock(app, variantId, 5);
      await addToCart(app, accessToken, variantId, 1);

      const res = await request(server()).post('/orders').set(authHeader(accessToken)).set(idempotencyKeyHeader());
      expect(res.status).toBe(201);

      expect(BigInt(user.id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
      const owners = await pool.query<{ owned: string; user_id: string; type: string }>(
        `SELECT 'carts' AS owned, user_id::text, pg_typeof(user_id)::text AS type FROM carts
         UNION ALL
         SELECT 'orders', user_id::text, pg_typeof(user_id)::text FROM orders
         ORDER BY 1`,
      );
      expect(owners.rows).toEqual([
        { owned: 'carts', user_id: user.id, type: 'bigint' },
        { owned: 'orders', user_id: user.id, type: 'bigint' },
      ]);
    });

    it('rejects checkout from an empty cart with 400', async () => {
      const token = await newPrincipalToken(app);

      const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

      expect(res.status).toBe(400);
    });

    it('stores an order total past int32', async () => {
      const token = await newPrincipalToken(app);
      // Each line fits int32; their sum does not.
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

    it('leaves the cart intact after checkout', async () => {
      const token = await newPrincipalToken(app);
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

  it('reads a checked-out order by id and in the paged list', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5);
    await addToCart(app, token, variantId, 3);
    const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
    const orderId = created.body.id;

    const byId = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));
    const list = await request(server()).get('/orders').set(authHeader(token));

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: orderId, totalAmountMinor: 300_000 });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(list.body.items.map((o: { id: string }) => o.id)).toEqual([orderId]);
  });

  it('keeps the total unchanged when Catalog reprices after checkout', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5);
    await addToCart(app, token, variantId, 2);
    const created = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
    const orderId = created.body.id;
    expect(created.body.totalAmountMinor).toBe(200_000);

    await repriceSku(app, variantId, 150_000);

    const res = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.items[0].unitPriceMinor).toBe(100_000);
    expect(res.body.totalAmountMinor).toBe(200_000);
  });

  it("hides another user's order behind the same 404 as an unknown id", async () => {
    const tokenA = await newPrincipalToken(app);
    const tokenB = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5);
    await addToCart(app, tokenA, variantId, 1);
    const created = await request(server()).post('/orders').set(authHeader(tokenA)).set(idempotencyKeyHeader());
    const orderId = created.body.id;

    const getByB = await request(server()).get(`/orders/${orderId}`).set(authHeader(tokenB));
    const unknown = await request(server()).get(`/orders/${ABSENT_UUID}`).set(authHeader(tokenB));
    const listB = await request(server()).get('/orders').set(authHeader(tokenB));

    expect(getByB.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(listB.body.items).toEqual([]);
  });
});
