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

const ABSENT_ORDER_UUID = '00000000-0000-4000-8000-000000000000';

// POST /orders/:id/pay over real Postgres: session creation snapshots the order total into a single
// PENDING Payment. This is the "never double-charge" entry point, before any webhook lands.
describe('Create payment session (integration, real Postgres)', () => {
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

  async function createPendingOrder(
    token: string,
    priceMinor = 150_000,
    qty = 1,
  ): Promise<{ orderId: string; totalMinor: number }> {
    const { variantId } = await createTestProduct(app, { priceMinor });
    await seedStock(app, variantId, qty + 5);
    await request(server())
      .post('/cart/items')
      .set(authHeader(token))
      .send({ skuId: variantId, quantity: qty })
      .expect(200);
    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);
    return { orderId: res.body.id as string, totalMinor: res.body.totalAmountMinor as number };
  }

  async function paymentsForOrder(orderId: string) {
    return db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));
  }

  it('opens a session for a PENDING order (201, one PENDING payment, amount snapshotted from order total)', async () => {
    const token = await newUser();
    const { orderId, totalMinor } = await createPendingOrder(token, 199_000, 2);

    const res = await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(token));

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toEqual(expect.any(String));
    expect(res.body.providerSessionId).toMatch(/^cs_test_/);
    expect(res.body.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const rows = await paymentsForOrder(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      provider: 'stripe',
      amountMinor: totalMinor,
      currency: 'VND',
      providerSessionId: res.body.providerSessionId,
      providerIntentId: null,
    });
  });

  it('rejects an unauthenticated pay with 401 and persists nothing', async () => {
    const token = await newUser();
    const { orderId } = await createPendingOrder(token);

    const res = await request(server()).post(`/orders/${orderId}/pay`);

    expect(res.status).toBe(401);
    expect(await paymentsForOrder(orderId)).toHaveLength(0);
  });

  it("returns 404 when paying another user's order (never leaks the order id) and persists nothing", async () => {
    const owner = await newUser();
    const other = await newUser();
    const { orderId } = await createPendingOrder(owner);

    const res = await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(other));

    expect(res.status).toBe(404);
    expect(await paymentsForOrder(orderId)).toHaveLength(0);
  });

  it('returns 404 for an unknown order id', async () => {
    const token = await newUser();
    const res = await request(server()).post(`/orders/${ABSENT_ORDER_UUID}/pay`).set(authHeader(token));
    expect(res.status).toBe(404);
  });

  it('rejects a second session while one is active (409, still exactly one payment)', async () => {
    const token = await newUser();
    const { orderId } = await createPendingOrder(token);

    await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(token)).expect(201);
    const second = await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(token));

    expect(second.status).toBe(409);
    expect(await paymentsForOrder(orderId)).toHaveLength(1);
  });

  it('rejects paying a non-PENDING order (409, no payment)', async () => {
    const token = await newUser();
    const { orderId } = await createPendingOrder(token);
    // Moved out of PENDING by a direct write rather than through finalize; pay must still refuse.
    await db.update(schema.orders).set({ status: 'CANCELLED' }).where(eq(schema.orders.id, orderId));

    const res = await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(token));

    expect(res.status).toBe(409);
    expect(await paymentsForOrder(orderId)).toHaveLength(0);
  });
});
