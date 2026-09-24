import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { buyerWithCart, checkout, readStock, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

// The check constraints decide what a level may become; the endpoint reports a violation as 409.
describe('Admin inventory (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);

  beforeEach(async () => {
    await resetDatabase(pool);
    adminToken = (await createTestAdminPrincipal(app)).accessToken;
  });

  const server = () => app.getHttpServer();

  const setStock = (variantId: string, quantityOnHand: number): request.Test =>
    request(server()).put(`/admin/inventory/${variantId}`).set(authHeader(adminToken)).send({ quantityOnHand });

  const adjustStock = (variantId: string, delta: number): request.Test =>
    request(server()).post(`/admin/inventory/${variantId}/adjust`).set(authHeader(adminToken)).send({ delta });

  const getStock = (variantId: string): request.Test =>
    request(server()).get(`/admin/inventory/${variantId}`).set(authHeader(adminToken));

  async function skuWithHold(onHand: number, quantity: number): Promise<string> {
    const { variantId } = await seedSellableSku(app, { onHand });
    const token = await buyerWithCart(app, variantId, quantity);
    await checkout(app, token).expect(201);
    return variantId;
  }

  describe('PUT /admin/inventory/:variantId', () => {
    it('creates a valid stock row for a SKU that has never had one', async () => {
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      expect(await readStock(app, variantId)).toBeUndefined();

      const res = await setStock(variantId, 40).expect(200);

      expect(res.body).toEqual({ variantId, quantityOnHand: 40, quantityReserved: 0, available: 40 });
      expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: 40, quantityReserved: 0 });
    });

    it('restates an existing level and leaves its reservations alone', async () => {
      const variantId = await skuWithHold(10, 4);

      const res = await setStock(variantId, 25).expect(200);

      expect(res.body).toEqual({ variantId, quantityOnHand: 25, quantityReserved: 4, available: 21 });
    });

    it('refuses a level below what is already reserved', async () => {
      const variantId = await skuWithHold(10, 4);

      await setStock(variantId, 3).expect(409);

      expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 4 });
    });

    it('rejects a negative, fractional or over-specified level with 400', async () => {
      const { variantId } = await seedSellableSku(app, { onHand: 5 });

      await setStock(variantId, -1).expect(400);
      await request(server())
        .put(`/admin/inventory/${variantId}`)
        .set(authHeader(adminToken))
        .send({ quantityOnHand: 1.5 })
        .expect(400);
      await request(server())
        .put(`/admin/inventory/${variantId}`)
        .set(authHeader(adminToken))
        .send({ quantityOnHand: 5, quantityReserved: 99 })
        .expect(400);
    });
  });

  describe('POST /admin/inventory/:variantId/adjust', () => {
    it('moves the level by a delta and returns the new level', async () => {
      const variantId = await skuWithHold(10, 4);

      expect((await adjustStock(variantId, 15).expect(200)).body).toEqual({
        variantId,
        quantityOnHand: 25,
        quantityReserved: 4,
        available: 21,
      });
      expect((await adjustStock(variantId, -5).expect(200)).body).toMatchObject({ quantityOnHand: 20 });
    });

    it('refuses to adjust a SKU whose stock was never initialised', async () => {
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });

      await adjustStock(variantId, 25).expect(404);

      expect(await readStock(app, variantId)).toBeUndefined();
    });

    it('refuses an adjustment that would oversell or go below zero', async () => {
      const variantId = await skuWithHold(10, 4);

      await adjustStock(variantId, -7).expect(409);
      await adjustStock(variantId, -20).expect(409);

      expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 4 });
    });

    it('rejects a zero delta with 400', async () => {
      const { variantId } = await seedSellableSku(app, { onHand: 5 });

      await adjustStock(variantId, 0).expect(400);
    });
  });

  describe('GET /admin/inventory/:variantId', () => {
    it('reads a level back with available derived from it', async () => {
      const variantId = await skuWithHold(10, 4);

      expect((await getStock(variantId).expect(200)).body).toEqual({
        variantId,
        quantityOnHand: 10,
        quantityReserved: 4,
        available: 6,
      });
    });

    it('answers 404 for a SKU with no stock row, and 400 for a malformed id', async () => {
      await getStock(ABSENT_UUID).expect(404);
      await request(server()).get('/admin/inventory/not-a-uuid').set(authHeader(adminToken)).expect(400);
    });
  });
});
