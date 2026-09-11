import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newUserToken } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const FIXED_KEY = '5c3f2b1a-9d8e-4c7b-8a6f-1e2d3c4b5a69';

// Wired-route contract for the idempotency layer on POST /orders over real Postgres. The
// concurrent-race and reclaim proofs live in the concurrency spec; the interceptor's per-branch
// logic is unit-tested separately.
describe('Idempotency on POST /orders (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  it('rejects an authenticated POST /orders without an Idempotency-Key (400)', async () => {
    const token = await newUserToken(app);

    const res = await request(server()).post('/orders').set(authHeader(token));

    expect(res.status).toBe(400);
  });

  it('rejects a non-UUID Idempotency-Key (400)', async () => {
    const token = await newUserToken(app);

    const res = await request(server()).post('/orders').set(authHeader(token)).set({ 'Idempotency-Key': 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('replays the first order on a sequential retry with the same key (one order, not two)', async () => {
    const token = await newUserToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5); // checkout now holds stock — seed enough on-hand
    await addToCart(app, token, variantId, 2);

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
