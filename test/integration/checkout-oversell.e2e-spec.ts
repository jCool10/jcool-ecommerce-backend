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
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// The boss-fight proof at the REAL endpoint: N distinct buyers race POST /orders (atomic checkout)
// for the last unit(s) over a REAL Postgres (each on its own connection, so the row lock / version-CAS
// actually contends — a mock DB can't show this). Each buyer has its own user, cart, and
// Idempotency-Key, so the idempotency layer is transparent and only STOCK contends. The invariant
// holds for BOTH lock strategies: exactly `min(onHand, N)` checkouts win (201 PENDING), on-hand never
// drops (two-phase hold), available never goes negative, every loser answers 409 and its whole
// checkout rolls back — no order and no reservation persist. Asserted on outcomes, not timing, so it
// stays deterministic.
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
    app = await createTestApp({ INVENTORY_LOCK_STRATEGY: strategy });
    // Bind a real port once. supertest ephemeral-listens a non-listening server per request; firing
    // CONTENDERS requests at it concurrently races those binds → ECONNRESET. A listening server is
    // just connected to, so the concurrency happens where we want it — in the DB, not the socket.
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

  // A fresh user (checkout isolates by user) with one contested SKU line in their cart, ready to buy.
  async function buyerFor(skuId: string, quantity: number): Promise<string> {
    const { accessToken } = await createTestUser(app);
    await request(server()).post('/cart/items').set(authHeader(accessToken)).send({ skuId, quantity }).expect(200);
    return accessToken;
  }

  // Seed `onHand`, build `contenders` buyers each wanting 1 unit, then fire every checkout at once.
  // Returns the contested variant and one status per buyer.
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

  // Distinct orders that carry a line for this SKU — one per winning checkout, zero for losers.
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

  // K = default optimistic retry budget (3). Exactly-K holds under both strategies: every optimistic
  // CAS miss implies a rival's reserving bump, so K misses exhaust the K units and the next re-read
  // sees available=0 → InsufficientStock (a terminal 409) before the retry budget is spent — no slot
  // is ever left unclaimed. (For K > the retry budget a contender could 409 as a conflict with a slot
  // still open; K=3 with the default budget of 3 stays clear of that.)
  it('onHand=K with N>K → exactly K check out, available floored at 0', async () => {
    const K = 3;
    const { variantId, statuses } = await race(K, CONTENDERS);

    expect(statuses.filter((s) => s === 201)).toHaveLength(K);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONTENDERS - K);

    const stock = await getStockView(app, variantId);
    // available pinned to exactly 0 (never negative) — no oversell even with K units contended.
    expect(stock).toEqual({ onHand: K, reserved: K, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(K);
    expect(await orderLineCount(variantId)).toBe(K);
  });
});
