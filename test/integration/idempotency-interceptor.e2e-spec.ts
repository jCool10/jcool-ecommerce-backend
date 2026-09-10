import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const FIXED_KEY = '5c3f2b1a-9d8e-4c7b-8a6f-1e2d3c4b5a69';

// Wired-route contract for the idempotency layer on POST /orders over real Postgres. The
// concurrent-race and reclaim proofs live in the concurrency spec; the interceptor's per-branch
// logic is unit-tested separately.
describe('Idempotency on POST /orders (integration, real Postgres)', () => {
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

  it('rejects an authenticated POST /orders without an Idempotency-Key (400)', async () => {
    const token = await newUser();

    const res = await request(server()).post('/orders').set(authHeader(token));

    expect(res.status).toBe(400);
  });

  it('rejects a non-UUID Idempotency-Key (400)', async () => {
    const token = await newUser();

    const res = await request(server()).post('/orders').set(authHeader(token)).set({ 'Idempotency-Key': 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('replays the first order on a sequential retry with the same key (one order, not two)', async () => {
    const token = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5); // checkout now holds stock — seed enough on-hand
    await addToCart(token, variantId, 2);

    const first = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(FIXED_KEY));
    const second = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(FIXED_KEY));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same result replayed byte-for-byte — same order id, not a freshly created second order.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toEqual(first.body);

    // Exactly one order exists for the user, and the key is frozen COMPLETED (single stored row).
    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toHaveLength(1);

    const keyRows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, FIXED_KEY));
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0].status).toBe('COMPLETED');
  });
});
