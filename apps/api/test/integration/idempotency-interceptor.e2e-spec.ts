import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const FIXED_KEY = '5c3f2b1a-9d8e-4c7b-8a6f-1e2d3c4b5a69';

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

  it('rejects a missing or non-UUID Idempotency-Key with 400', async () => {
    const token = await newPrincipalToken(app);

    const missing = await request(server()).post('/orders').set(authHeader(token));
    const malformed = await request(server())
      .post('/orders')
      .set(authHeader(token))
      .set({ 'Idempotency-Key': 'not-a-uuid' });

    expect([missing.status, malformed.status]).toEqual([400, 400]);
  });

  it('replays the first order on a sequential retry with the same key', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5);
    await addToCart(app, token, variantId, 2);

    const first = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(FIXED_KEY));
    const second = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(FIXED_KEY));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toHaveLength(1);

    const keyRows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, FIXED_KEY));
    expect(keyRows).toEqual([{ status: 'COMPLETED' }]);
  });
});
