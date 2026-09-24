import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_LINE_QUANTITY } from '../../src/modules/cart/cart.constants';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct, repriceSku } from '../setup/fixtures/catalog.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('Cart (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  describe('GET /cart', () => {
    it('creates an empty cart on first read', async () => {
      const token = await newPrincipalToken(app);

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.subtotalMinor).toBe(0);
    });

    it('sums the subtotal from live prices across lines', async () => {
      const token = await newPrincipalToken(app);
      const a = await createTestProduct(app, { priceMinor: 199_000 });
      const b = await createTestProduct(app, { priceMinor: 50_000 });

      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: a.variantId, quantity: 2 });
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: b.variantId, quantity: 1 });

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.subtotalMinor).toBe(199_000 * 2 + 50_000);
      expect(res.body.currency).toBe('VND');
    });
  });

  describe('POST /cart/items', () => {
    it('adds a SKU to an empty cart at its live price', async () => {
      const token = await newPrincipalToken(app);
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
      const token = await newPrincipalToken(app);
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

    it('clamps a line at the per-line cap across repeated adds', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);
      const add = (quantity: number) =>
        request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity });

      await add(MAX_LINE_QUANTITY).expect(200);
      const res = await add(1);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([expect.objectContaining({ skuId: variantId, quantity: MAX_LINE_QUANTITY })]);
    });

    it('rejects a zero, negative or over-cap quantity with 400', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);

      const statuses: number[] = [];
      for (const quantity of [0, -3, 3_000_000_000]) {
        const res = await request(server())
          .post('/cart/items')
          .set(authHeader(token))
          .send({ skuId: variantId, quantity });
        statuses.push(res.status);
      }

      expect(statuses).toEqual([400, 400, 400]);
    });

    it('returns 404 when the SKU does not exist in Catalog', async () => {
      const token = await newPrincipalToken(app);

      const res = await request(server())
        .post('/cart/items')
        .set(authHeader(token))
        .send({ skuId: ABSENT_UUID, quantity: 1 });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /cart/items/:skuId', () => {
    it('sets a line to an absolute quantity', async () => {
      const token = await newPrincipalToken(app);
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
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);

      const res = await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: 3 });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /cart/items/:skuId', () => {
    it('removes one line from the cart', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);
      await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 1 });

      const res = await request(server()).delete(`/cart/items/${variantId}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('answers 200 when deleting a line that is not there', async () => {
      const token = await newPrincipalToken(app);

      const res = await request(server()).delete(`/cart/items/${ABSENT_UUID}`).set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe('DELETE /cart', () => {
    it('clears every line', async () => {
      const token = await newPrincipalToken(app);
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

  it('reflects a Catalog price change on the next read', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId: variantId, quantity: 2 });

    await repriceSku(app, variantId, 150_000);

    const res = await request(server()).get('/cart').set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.items[0].unitPriceMinor).toBe(150_000);
    expect(res.body.subtotalMinor).toBe(300_000);
  });

  it("does not leak one user's items into another user's cart", async () => {
    const tokenA = await newPrincipalToken(app);
    const tokenB = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app);
    await request(server()).post('/cart/items').set(authHeader(tokenA)).send({ skuId: variantId, quantity: 1 });

    const resA = await request(server()).get('/cart').set(authHeader(tokenA));
    const resB = await request(server()).get('/cart').set(authHeader(tokenB));

    expect(resA.body.items).toHaveLength(1);
    expect(resB.body.items).toEqual([]);
  });
});
