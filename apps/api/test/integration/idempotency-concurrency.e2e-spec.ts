import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { computeRequestHash } from '../../src/shared/idempotency';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// A replay is also a 201, so the order and hold counts are the verdict. Ample stock lets a duplicate
// order show up as a second row instead of a shortfall 409.
const CONTENDERS = 16;
const AMPLE_STOCK = 50;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('Idempotent checkout (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  async function newUser(): Promise<{ token: string; userId: string }> {
    const { accessToken, user } = await createTestPrincipal(app);
    return { token: accessToken, userId: user.id };
  }

  function postOrder(token: string, key: string): request.Test {
    return request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));
  }

  async function ordersOf(token: string): Promise<{ id: string }[]> {
    const res = await request(server()).get('/orders').set(authHeader(token));
    return (res.body as { items: { id: string }[] }).items;
  }

  it('creates one order and one hold for concurrent requests sharing a key', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);
    const key = randomUUID();

    const settled = await Promise.allSettled(range(CONTENDERS).map(() => postOrder(token, key)));
    const responses: request.Response[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') responses.push(r.value);
    }
    expect(responses).toHaveLength(CONTENDERS);
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const created = responses.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.id as string)).size).toBe(1);

    expect(await ordersOf(token)).toHaveLength(1);
    expect(await countHeldReservations(app, variantId)).toBe(1);
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 1,
      available: AMPLE_STOCK - 1,
    });
  });

  it('creates two orders for two keys on the same cart', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);

    const first = await postOrder(token, randomUUID());
    const second = await postOrder(token, randomUUID());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    expect(await ordersOf(token)).toHaveLength(2);
    expect(await countHeldReservations(app, variantId)).toBe(2);
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 2,
      available: AMPLE_STOCK - 2,
    });
  });

  it('answers 422 to a key reused with a different body, with no second order', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);
    const key = randomUUID();

    const first = await postOrder(token, key);
    expect(first.status).toBe(201);

    const reused = await postOrder(token, key).send({ tampered: true });
    expect(reused.status).toBe(422);

    expect(await ordersOf(token)).toHaveLength(1);
  });

  it('returns the committed order when its key row was swept, with no second hold', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);
    const key = randomUUID();

    const first = await postOrder(token, key);
    expect(first.status).toBe(201);
    const orderId = first.body.id as string;

    // orders.idempotency_key still stamps the committed order after the key row is gone.
    await db.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key));

    const retry = await postOrder(token, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(orderId);

    expect(await ordersOf(token)).toHaveLength(1);
    expect(await countHeldReservations(app, variantId)).toBe(1);
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 1,
      available: AMPLE_STOCK - 1,
    });

    const [row] = await db
      .select({ status: schema.idempotencyKeys.status, orderId: schema.idempotencyKeys.orderId })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(row.status).toBe('COMPLETED');
    expect(row.orderId).toBe(orderId);
  });

  it('reclaims an IN_PROGRESS key past its lease and checks out exactly one order', async () => {
    const { token, userId } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);
    const key = randomUUID();
    const scope = `user:${userId}`;

    // A matching request hash reaches the reclaim path rather than the 422 branch. createdAt (not
    // expiresAt) is what the interceptor's lease reads, so it is backdated past it here; expiresAt
    // stays the normal 24h out, since the row's overall replay window is untouched by the lease.
    const body = { marker: true };
    await db.insert(schema.idempotencyKeys).values({
      scope,
      key,
      requestHash: computeRequestHash('POST', '/orders', scope, body),
      status: 'IN_PROGRESS',
      method: 'POST',
      path: '/orders',
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const retry = await postOrder(token, key).send(body);
    expect(retry.status).toBe(201);

    expect(await ordersOf(token)).toHaveLength(1);
    expect(await countHeldReservations(app, variantId)).toBe(1);

    const rows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETED');
  });

  it('re-runs a key whose checkout failed on stock instead of caching the 409', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 1);
    await addToCart(app, token, variantId, 2);
    const key = randomUUID();

    const first = await postOrder(token, key);
    const second = await postOrder(token, key);

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);

    expect(await ordersOf(token)).toEqual([]);
    expect(await countHeldReservations(app, variantId)).toBe(0);
    expect(await getStockView(app, variantId)).toEqual({ onHand: 1, reserved: 0, available: 1 });

    const rows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(rows).toHaveLength(0);
  });
});
