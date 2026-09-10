import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { buyerWithCart, checkout, readStock, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestAdmin, createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The stock-admin surface over real Postgres, where the interesting assertions are: the database
 * check constraints are the authority on what a level may become, and the endpoint's job is to
 * report a violation as a conflict about current stock rather than as a 500.
 */
describe('Admin inventory (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;

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
  });

  const server = () => app.getHttpServer();

  const setStock = (variantId: string, quantityOnHand: number): request.Test =>
    request(server()).put(`/admin/inventory/${variantId}`).set(authHeader(adminToken)).send({ quantityOnHand });

  const adjustStock = (variantId: string, delta: number): request.Test =>
    request(server()).post(`/admin/inventory/${variantId}/adjust`).set(authHeader(adminToken)).send({ delta });

  const getStock = (variantId: string): request.Test =>
    request(server()).get(`/admin/inventory/${variantId}`).set(authHeader(adminToken));

  /** The hold is a real, still-pending order's, not a hand-written reservation row. */
  async function skuWithHold(onHand: number, quantity: number): Promise<string> {
    const { variantId } = await seedSellableSku(app, { onHand });
    const token = await buyerWithCart(app, variantId, quantity);
    await checkout(app, token).expect(201);
    return variantId;
  }

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await request(server()).get(`/admin/inventory/${ABSENT_UUID}`).expect(401);
    });

    it('rejects a signed-in non-admin with 403', async () => {
      const { accessToken } = await createTestUser(app);
      await request(server()).get(`/admin/inventory/${ABSENT_UUID}`).set(authHeader(accessToken)).expect(403);
      await request(server())
        .put(`/admin/inventory/${ABSENT_UUID}`)
        .set(authHeader(accessToken))
        .send({ quantityOnHand: 5 })
        .expect(403);
    });
  });

  describe('PUT /admin/inventory/:variantId', () => {
    it('creates a valid stock row for a SKU that has never had one', async () => {
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      expect(await readStock(app, variantId)).toBeUndefined();

      const res = await setStock(variantId, 40).expect(200);

      expect(res.body).toEqual({ variantId, quantityOnHand: 40, quantityReserved: 0, available: 40 });
      const row = await readStock(app, variantId);
      expect(row).toMatchObject({ quantityOnHand: 40, quantityReserved: 0 });
      // The id and the timestamps are minted client-side by Drizzle's `$defaultFn`, not by a column
      // default — so a row carrying them is the evidence this write went through the ORM. Raw SQL
      // here would insert a NULL id and fail, or worse, drift from every other table's shape.
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it('restates the level of a SKU that already has one, leaving its reservations alone', async () => {
      const variantId = await skuWithHold(10, 4);

      const res = await setStock(variantId, 25).expect(200);

      expect(res.body).toEqual({ variantId, quantityOnHand: 25, quantityReserved: 4, available: 21 });
    });

    // 409, not 500: "you have already promised 4 of these" is a fact about current stock, and the
    // database check constraint is what establishes it.
    it('refuses a level below what is already reserved', async () => {
      const variantId = await skuWithHold(10, 4);

      await setStock(variantId, 3).expect(409);

      expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 4 });
    });

    it('rejects a negative or non-integer level as a bad request', async () => {
      const { variantId } = await seedSellableSku(app, { onHand: 5 });

      await setStock(variantId, -1).expect(400);
      await request(server())
        .put(`/admin/inventory/${variantId}`)
        .set(authHeader(adminToken))
        .send({ quantityOnHand: 1.5 })
        .expect(400);
      // Whitelisted body: an unknown field is a typo in a stock write, not something to ignore.
      await request(server())
        .put(`/admin/inventory/${variantId}`)
        .set(authHeader(adminToken))
        .send({ quantityOnHand: 5, quantityReserved: 99 })
        .expect(400);
    });
  });

  describe('POST /admin/inventory/:variantId/adjust', () => {
    it('moves the level by a delta and returns what the database computed', async () => {
      const variantId = await skuWithHold(10, 4);

      expect((await adjustStock(variantId, 15).expect(200)).body).toEqual({
        variantId,
        quantityOnHand: 25,
        quantityReserved: 4,
        available: 21,
      });
      expect((await adjustStock(variantId, -5).expect(200)).body).toMatchObject({ quantityOnHand: 20 });
    });

    // Not an upsert from zero: "add 25" against a starting point nobody set would be inventing it.
    it('refuses to adjust a SKU whose stock was never initialised', async () => {
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });

      await adjustStock(variantId, 25).expect(404);

      expect(await readStock(app, variantId)).toBeUndefined();
    });

    it('refuses an adjustment that would oversell or go below zero', async () => {
      const variantId = await skuWithHold(10, 4);

      await adjustStock(variantId, -7).expect(409); // would leave 3 on hand against 4 reserved
      await adjustStock(variantId, -20).expect(409); // would leave on hand negative

      expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 4 });
    });

    it('rejects a zero delta, which asks for a write that means nothing', async () => {
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
