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
import { readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';

// POST /orders holds stock through the checkout saga's Try before it answers.
describe('Checkout holds stock (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  const server = () => app.getHttpServer();

  async function stockOf(variantId: string): Promise<{ onHand: number; reserved: number }> {
    const [row] = await db
      .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  it('refuses the whole checkout with 409 when one line is short, and holds nothing', async () => {
    const { user, accessToken: token } = await createTestPrincipal(app);
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5);
    await seedStock(app, b.variantId, 1);
    await addToCart(app, token, a.variantId, 2);
    await addToCart(app, token, b.variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.userId, user.id));
    expect(orders.map((order) => order.status)).toEqual(['REJECTED']);
    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toEqual([]);
    expect(await stockOf(a.variantId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockOf(b.variantId)).toEqual({ onHand: 1, reserved: 0 });
    expect(await db.select().from(schema.reservations)).toHaveLength(0);
  });

  it('holds stock on a successful checkout under a participant header for the order', async () => {
    const { accessToken: token } = await createTestPrincipal(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 5);
    await addToCart(app, token, variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(await stockOf(variantId)).toEqual({ onHand: 5, reserved: 2 });
    expect((await readReservationOrder(app, res.body.id))?.status).toBe('HELD');
  });

  it('answers a stock shortfall with a message that hides the available count', async () => {
    const { accessToken: token } = await createTestPrincipal(app);
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
