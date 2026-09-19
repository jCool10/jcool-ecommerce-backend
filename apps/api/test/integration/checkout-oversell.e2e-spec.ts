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
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newUserToken } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// N distinct buyers race POST /orders for the last unit(s), each on its own connection so the row
// lock / version-CAS actually contends. Each buyer has its own user, cart, and Idempotency-Key, so
// the idempotency layer is transparent and only STOCK contends. Asserted on outcomes, not timing.
//
// > pool max (10) so the DB, not the app, is where the race is decided. No-deadlock rests on each
// checkout using exactly one connection for its whole transaction (cart/catalog reads happen before
// the tx opens; the contended stock-row lock is always held by a tx that waits on nothing else).
const CONTENDERS = 16;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe.each(['pessimistic', 'optimistic'] as const)('Checkout oversell race [%s]', (strategy) => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ INVENTORY_LOCK_STRATEGY: strategy }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  async function buyerFor(skuId: string, quantity: number): Promise<string> {
    const accessToken = await newUserToken(app);
    await addToCart(app, accessToken, skuId, quantity);
    return accessToken;
  }

  async function race(
    onHand: number,
    contenders: number,
  ): Promise<{ variantId: string; statuses: (number | 'errored')[] }> {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, product.variantId, onHand);
    const tokens = await Promise.all(range(contenders).map(() => buyerFor(product.variantId, 1)));

    const settled = await Promise.allSettled(
      tokens.map((token) => request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader())),
    );
    const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : ('errored' as const)));
    return { variantId: product.variantId, statuses };
  }

  async function orderLineCount(variantId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.orderItems.id })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.skuId, variantId));
    return rows.length;
  }

  it('N buyers contend for the last unit → exactly one checks out, the rest 409, no oversell', async () => {
    const { variantId, statuses } = await race(1, CONTENDERS);

    const winners = statuses.filter((s) => s === 201);
    const losers = statuses.filter((s) => s === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONTENDERS - 1); // every non-winner answered a clean 409, none errored

    const stock = await getStockView(app, variantId);
    // available pinned to exactly 0 (never negative) — the no-oversell invariant, on-hand undecremented.
    expect(stock).toEqual({ onHand: 1, reserved: 1, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(1);
    // Every loser's checkout rolled fully back: exactly one order carries the SKU (the winner's).
    expect(await orderLineCount(variantId)).toBe(1);
  });

  // K equals the default optimistic retry budget (3) on purpose: every CAS miss implies a rival's
  // reserving bump, so K misses exhaust the K units and the next re-read sees available=0 — a
  // terminal 409 — before the budget is spent, leaving no slot unclaimed. With K above the budget a
  // contender could 409 as a conflict with a slot still open.
  it('onHand=K with N>K → exactly K check out, available floored at 0', async () => {
    const K = 3;
    const { variantId, statuses } = await race(K, CONTENDERS);

    expect(statuses.filter((s) => s === 201)).toHaveLength(K);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONTENDERS - K);

    const stock = await getStockView(app, variantId);
    expect(stock).toEqual({ onHand: K, reserved: K, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(K);
    expect(await orderLineCount(variantId)).toBe(K);
  });
});
