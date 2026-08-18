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

// The boss-fight proof: N buyers race for the last unit(s) over a REAL Postgres (each on its
// own connection, so the row lock / version-CAS actually contends — a mock DB can't show this).
// The invariant holds for BOTH lock strategies: exactly `min(onHand, N)` placements win, on-hand
// never drops (two-phase hold), available never goes negative, every loser answers 409 and its
// order rolls fully back to DRAFT with no orphan reservation. Asserted on outcomes, not timing,
// so it stays deterministic. The DB CHECK constraint as last line of defense is proven in
// inventory-pessimistic-reserve.e2e-spec.ts; the optimistic retry/exhaustion branches that a
// concurrent CAS reaches live in inventory-optimistic-contention.e2e-spec.ts.
// > pool max (10) so the DB, not the app, is where the race is decided. No-deadlock rests on each
// placement using exactly one connection for its whole transaction (no nested pool acquire inside
// the place tx) — the contended stock-row lock is always held by a tx that waits on nothing else.
const CONTENDERS = 16;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe.each(['pessimistic', 'optimistic'] as const)('Place order oversell race [%s]', (strategy) => {
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

  interface Draft {
    orderId: string;
    token: string;
  }

  // A fresh user (placement isolates by user), one contested SKU line, a DRAFT order ready to place.
  async function draftFor(skuId: string, quantity: number): Promise<Draft> {
    const { accessToken } = await createTestUser(app);
    await request(server()).post('/cart/items').set(authHeader(accessToken)).send({ skuId, quantity }).expect(200);
    const created = await request(server())
      .post('/orders')
      .set(authHeader(accessToken))
      .set(idempotencyKeyHeader())
      .expect(201);
    return { orderId: created.body.id as string, token: accessToken };
  }

  interface RaceOutcome {
    draft: Draft;
    status: number | 'errored';
  }

  // Seed `onHand`, build `contenders` draft orders each wanting 1 unit, then fire every
  // placement at once. Returns the contested variant and one outcome per order (index-aligned).
  async function race(onHand: number, contenders: number): Promise<{ variantId: string; outcomes: RaceOutcome[] }> {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, product.variantId, onHand);
    const drafts = await Promise.all(range(contenders).map(() => draftFor(product.variantId, 1)));

    const settled = await Promise.allSettled(
      drafts.map((d) => request(server()).post(`/orders/${d.orderId}/place`).set(authHeader(d.token))),
    );
    const outcomes: RaceOutcome[] = drafts.map((draft, i) => {
      const r = settled[i];
      return { draft, status: r.status === 'fulfilled' ? r.value.status : 'errored' };
    });
    return { variantId: product.variantId, outcomes };
  }

  async function orderStatus(draft: Draft): Promise<string> {
    const res = await request(server()).get(`/orders/${draft.orderId}`).set(authHeader(draft.token));
    return res.body.status as string;
  }

  it('N buyers contend for the last unit → exactly one wins, the rest 409, no oversell', async () => {
    const { variantId, outcomes } = await race(1, CONTENDERS);

    const winners = outcomes.filter((o) => o.status === 200);
    const losers = outcomes.filter((o) => o.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONTENDERS - 1); // every non-winner answered a clean 409, none errored

    const stock = await getStockView(app, variantId);
    // available pinned to exactly 0 (never negative) — the no-oversell invariant, on-hand undecremented.
    expect(stock).toEqual({ onHand: 1, reserved: 1, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(1);

    // Every loser rolled fully back: order still DRAFT; the winner is PENDING.
    const loserStatuses = await Promise.all(losers.map((o) => orderStatus(o.draft)));
    expect(loserStatuses.every((s) => s === 'DRAFT')).toBe(true);
    expect(await orderStatus(winners[0].draft)).toBe('PENDING');

    // No orphan reservation rows: total for the SKU equals the single winning hold.
    const allForSku = await db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(eq(schema.reservations.variantId, variantId));
    expect(allForSku).toHaveLength(1);
  });

  // K = default optimistic retry budget (3). Exactly-K holds under both strategies: every optimistic
  // CAS miss implies a rival's reserving bump, so K misses exhaust the K units and the next re-read
  // sees available=0 → InsufficientStock (a terminal 409) before the retry budget is spent — no slot
  // is ever left unclaimed. (For K > the retry budget a contender could 409 as a conflict with a slot
  // still open; K=3 with the default budget of 3 stays clear of that.)
  it('onHand=K with N>K → exactly K win, available floored at 0', async () => {
    const K = 3;
    const { variantId, outcomes } = await race(K, CONTENDERS);

    expect(outcomes.filter((o) => o.status === 200)).toHaveLength(K);
    expect(outcomes.filter((o) => o.status === 409)).toHaveLength(CONTENDERS - K);

    const stock = await getStockView(app, variantId);
    // available pinned to exactly 0 (never negative) — no oversell even with K units contended.
    expect(stock).toEqual({ onHand: K, reserved: K, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(K);
  });
});
