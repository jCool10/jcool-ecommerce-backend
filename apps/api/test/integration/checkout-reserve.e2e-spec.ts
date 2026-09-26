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

// POST /orders holds stock in the same transaction that creates the order.
describe('Checkout holds stock (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  async function stockOf(variantId: string): Promise<{ onHand: number; reserved: number }> {
    const [row] = await db
      .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  it('rolls the whole checkout back with 409 when one line is short', async () => {
    const token = await newPrincipalToken(app);
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5);
    await seedStock(app, b.variantId, 1);
    await addToCart(app, token, a.variantId, 2);
    await addToCart(app, token, b.variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);
    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toEqual([]);
    expect(await stockOf(a.variantId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockOf(b.variantId)).toEqual({ onHand: 1, reserved: 0 });
    expect(await db.select().from(schema.reservations)).toHaveLength(0);
  });

  it('answers a stock shortfall with a message that hides the available count', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 1);
    await addToCart(app, token, variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);
    // Exact match, not a substring check: the real available count (1) must not sneak into the body
    // via a `1 unit remaining`-style phrasing either.
    expect(res.body.message).toBe('Insufficient stock');
  });
});
