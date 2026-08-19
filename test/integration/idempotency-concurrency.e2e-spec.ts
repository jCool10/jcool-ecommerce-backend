import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { computeRequestHash } from '../../src/shared/idempotency';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// The behaviour proof for idempotent checkout over a REAL Postgres — the count on the DB, not the
// HTTP status, is the verdict (a replay is also a 201, so status alone can't tell one order from two).
// Sibling specs own the adjacent cases: `idempotency-interceptor` covers the mandatory-header 400 and
// the sequential same-key replay; `checkout-oversell` covers N distinct keys racing the same stock.
// This spec proves what only a concurrent, real-DB run can: same-key fan-out collapses to one order,
// distinct keys stay independent, a reused key with a different body is rejected, and both crash-reclaim
// paths converge on a single order without a second hold.
//
// Stock is seeded WELL above one order's need on purpose: a duplicate order would then succeed on stock
// and reveal itself as a second row/hold, instead of being masked by a stock-shortfall 409.
const CONTENDERS = 16;
const AMPLE_STOCK = 50;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('Idempotent checkout — concurrency, reclaim & body mismatch (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await createTestApp();
    // Bind a real port: supertest ephemeral-listens a non-listening server per request, and firing the
    // same-key fan-out at it races those socket binds → ECONNRESET. A listening server moves the race
    // to where it belongs — the DB's unique (scope, key) index.
    await app.listen(0);
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

  async function newUser(): Promise<{ token: string; userId: string }> {
    const { accessToken, user } = await createTestUser(app);
    return { token: accessToken, userId: user.id };
  }

  async function addToCart(token: string, skuId: string, quantity: number): Promise<void> {
    await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity }).expect(200);
  }

  function postOrder(token: string, key: string): request.Test {
    return request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));
  }

  async function ordersOf(token: string): Promise<{ id: string }[]> {
    const res = await request(server()).get('/orders').set(authHeader(token));
    return res.body as { id: string }[];
  }

  it('N concurrent requests with the SAME key → exactly one order + one hold (rest replay/409, never 5xx)', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(token, variantId, 1);
    const key = randomUUID();

    const settled = await Promise.allSettled(range(CONTENDERS).map(() => postOrder(token, key)));
    const responses: request.Response[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') responses.push(r.value);
    }
    // None errored at the socket/framework level — every contender got a real HTTP answer.
    expect(responses).toHaveLength(CONTENDERS);
    // Winner + any replays answer 201; losers still in-flight answer 409. Nothing 5xx's.
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const created = responses.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    // Every 201 points at the one order — replays return the winner's id, not a fresh one.
    expect(new Set(created.map((r) => r.body.id as string)).size).toBe(1);

    // The verdict: one order, one HELD reservation, stock reserved exactly once.
    expect(await ordersOf(token)).toHaveLength(1);
    expect(await countHeldReservations(app, variantId)).toBe(1);
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 1,
      available: AMPLE_STOCK - 1,
    });
  });

  it('two sequential requests with DIFFERENT keys (same cart) → two distinct orders', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(token, variantId, 1);

    const first = await postOrder(token, randomUUID());
    const second = await postOrder(token, randomUUID());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id); // idempotency never swallows a genuinely new request

    expect(await ordersOf(token)).toHaveLength(2);
    expect(await countHeldReservations(app, variantId)).toBe(2);
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 2,
      available: AMPLE_STOCK - 2,
    });
  });

  it('same key replayed with a DIFFERENT request body → 422, no second order', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(token, variantId, 1);
    const key = randomUUID();

    const first = await postOrder(token, key);
    expect(first.status).toBe(201);

    // Same key, different payload → stored request hash no longer matches → reused-key error, not a
    // stale replay of the first request's result.
    const reused = await postOrder(token, key).send({ tampered: true });
    expect(reused.status).toBe(422);

    expect(await ordersOf(token)).toHaveLength(1);
  });

  it('crash-reclaim heal: order committed but idempotency row swept → retry returns the SAME order, no duplicate hold', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(token, variantId, 1);
    const key = randomUUID();

    const first = await postOrder(token, key);
    expect(first.status).toBe(201);
    const orderId = first.body.id as string;

    // Simulate a TTL sweep / crash after the order committed: the idempotency row is gone, but
    // orders.idempotency_key still stamps the committed order — the second-line defence.
    await db.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key));

    const retry = await postOrder(token, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(orderId); // healed onto the existing order, not created anew

    expect(await ordersOf(token)).toHaveLength(1);
    expect(await countHeldReservations(app, variantId)).toBe(1); // no second hold
    expect(await getStockView(app, variantId)).toEqual({
      onHand: AMPLE_STOCK,
      reserved: 1,
      available: AMPLE_STOCK - 1,
    });

    // The key is re-frozen COMPLETED and points back at the same order.
    const [row] = await db
      .select({ status: schema.idempotencyKeys.status, orderId: schema.idempotencyKeys.orderId })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(row.status).toBe('COMPLETED');
    expect(row.orderId).toBe(orderId);
  });

  it('reclaims an expired IN_PROGRESS holder (crashed owner, no order) → retry checks out exactly one order', async () => {
    const { token, userId } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(token, variantId, 1);
    const key = randomUUID();
    const scope = `user:${userId}`;

    // A prior attempt crashed mid-flight: an IN_PROGRESS row lingers past its TTL with no order behind
    // it. Its request hash matches the retry's shape so we exercise the reclaim path, not the 422 branch.
    const body = { marker: true };
    await db.insert(schema.idempotencyKeys).values({
      scope,
      key,
      requestHash: computeRequestHash('POST', '/orders', scope, body),
      status: 'IN_PROGRESS',
      method: 'POST',
      path: '/orders',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const retry = await postOrder(token, key).send(body);
    expect(retry.status).toBe(201);

    expect(await ordersOf(token)).toHaveLength(1); // reclaimed the stale holder and created one order
    expect(await countHeldReservations(app, variantId)).toBe(1);

    const rows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(rows).toHaveLength(1); // stale row replaced, not duplicated
    expect(rows[0].status).toBe('COMPLETED');
  });

  it('insufficient stock: retrying the same key stays 409 (business errors are never cached) — no order, no hold', async () => {
    const { token } = await newUser();
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, 1);
    await addToCart(token, variantId, 2); // order needs 2, only 1 on hand → whole checkout rolls back
    const key = randomUUID();

    const first = await postOrder(token, key);
    const second = await postOrder(token, key);

    expect(first.status).toBe(409);
    // IN_PROGRESS is dropped on failure, so the retry re-runs the handler (and 409s again) rather than
    // replaying a cached error.
    expect(second.status).toBe(409);

    expect(await ordersOf(token)).toEqual([]);
    expect(await countHeldReservations(app, variantId)).toBe(0);
    expect(await getStockView(app, variantId)).toEqual({ onHand: 1, reserved: 0, available: 1 });

    // Nothing cached: both failed attempts cleaned up their IN_PROGRESS rows.
    const rows = await db
      .select({ status: schema.idempotencyKeys.status })
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, key));
    expect(rows).toHaveLength(0);
  });
});
