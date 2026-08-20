import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  STOCK_REPOSITORY,
  type ReserveLine,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { InsufficientStockError } from '../../src/modules/inventory/domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../src/modules/inventory/domain/errors/reservation-conflict.error';
import { countHeldReservations, seedStock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// The two optimistic branches a single-thread test can't reach — they only fire when a CAS
// actually loses a version race. We force that race deterministically (no flaky sleeps deciding
// the winner): writer A holds its stock UPDATE in an open transaction (row lock held, version
// bumped but uncommitted); writer B reads the stale version and its UPDATE blocks on A's lock;
// when A commits, B's `WHERE version = <stale>` matches nothing — a guaranteed CAS miss with
// stock still ample (so the miss is contention, never a shortfall). Retry budget then decides:
// with retries B re-CASes and wins; with none B gives up as a ReservationConflictError. Stock is
// seeded well above demand so a miss can never be mistaken for out-of-stock. The shortfall branch
// (real out-of-stock → no retry) is the single-thread case in inventory-optimistic-reserve.e2e-spec.ts.
const SKU = '33333333-3333-4333-8333-333333333333';
const ORDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Contenders {
  db: DrizzleDB;
  pool: Pool;
  repo: StockRepositoryPort;
}

// Block until a backend is parked on a row lock — i.e. B has already done its stale-version read
// and its CAS UPDATE is now waiting on A's lock. This is the happens-before that makes the race
// deterministic (no timing guess): we only let A commit once B is provably committed to the stale
// version. A itself is idle-in-transaction (not "active"), so a single active Lock-waiter is B.
async function waitUntilBlockedOnLock(pool: Pool, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0].n) >= 1) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for B to block on the row lock');
    await sleep(20);
  }
}

/**
 * Run A and B so B is guaranteed to lose one version CAS to A, and return B's settled outcome.
 * A reserves then holds its tx open (row lock + uncommitted version bump). B reserves against the
 * still-committed (stale) version and its UPDATE parks on A's row lock — we wait until it provably
 * has (waitUntilBlockedOnLock) before committing A, so B's `WHERE version = stale` is guaranteed to
 * match nothing once A's new version lands. No sleep decides the winner. `line` is what each writer
 * holds (kept small; stock is ample). B is settled inside so no rejected promise is left unobserved.
 */
async function forceCasMiss({ db, pool, repo }: Contenders, line: ReserveLine): Promise<PromiseSettledResult<void>> {
  let releaseA!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
  let aReserved!: () => void;
  const aHasReserved = new Promise<void>((resolve) => (aReserved = resolve));

  const a = db.transaction(async (tx) => {
    await repo.reserveOptimistic(tx, ORDER_A, [line]);
    aReserved(); // A has bumped version (uncommitted); its row lock is held
    await aMayCommit; // hold the tx open so B contends against the stale version
  });
  await aHasReserved;

  // B reads the stale (still-committed) version, then its UPDATE parks on A's row lock.
  const b = db.transaction(async (tx) => {
    await repo.reserveOptimistic(tx, ORDER_B, [line]);
  });

  await waitUntilBlockedOnLock(pool); // B is now committed to the stale version and waiting on A
  releaseA();
  await a; // A commits: version moves, so B's `WHERE version = stale` will match nothing

  const [bResult] = await Promise.allSettled([b]);
  return bResult;
}

async function readStock(db: DrizzleDB, variantId: string) {
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
  return row;
}

describe('Inventory optimistic reserve under version contention (integration, real Postgres)', () => {
  describe('with a retry budget (default INVENTORY_OPTIMISTIC_MAX_RETRIES)', () => {
    let app: INestApplication;
    let pool: Pool;
    let db: DrizzleDB;
    let repo: StockRepositoryPort;

    beforeAll(async () => {
      app = await createTestApp({ INVENTORY_LOCK_STRATEGY: 'optimistic' });
      pool = app.get<Pool>(PG_POOL);
      db = app.get<DrizzleDB>(DRIZZLE);
      repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await resetDatabase(pool);
    });

    it('a writer that loses the CAS retries against the new version and still holds', async () => {
      await seedStock(app, SKU, 10); // ample: the miss is pure contention, never a shortfall

      // forceCasMiss guarantees B lost a CAS (it blocked on A's lock at the stale version); the
      // no-retry sibling below is the canary — if forcing ever failed to force, that one goes red.
      // So reaching the reserved=2 end-state here means B recovered via retry, not that it never contended.
      const result = await forceCasMiss({ db, pool, repo }, { variantId: SKU, quantity: 1 });
      expect(result.status).toBe('fulfilled'); // B re-read the new version, re-CASed, and won

      const stock = await readStock(db, SKU);
      expect(stock.quantityReserved).toBe(2); // both holds landed
      expect(stock.version).toBe(2); // one bump per winning CAS (A then B's retry)
      expect(stock.quantityOnHand - stock.quantityReserved).toBe(8);
      expect(await countHeldReservations(app, SKU)).toBe(2);
    });
  });

  describe('with no retry budget (INVENTORY_OPTIMISTIC_MAX_RETRIES=0)', () => {
    let app: INestApplication;
    let pool: Pool;
    let db: DrizzleDB;
    let repo: StockRepositoryPort;

    beforeAll(async () => {
      app = await createTestApp({ INVENTORY_LOCK_STRATEGY: 'optimistic', INVENTORY_OPTIMISTIC_MAX_RETRIES: '0' });
      pool = app.get<Pool>(PG_POOL);
      db = app.get<DrizzleDB>(DRIZZLE);
      repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await resetDatabase(pool);
    });

    it('a losing CAS with no retries fails as ReservationConflictError, not InsufficientStock', async () => {
      await seedStock(app, SKU, 10); // ample stock: the failure must be contention, not a shortfall

      const result = await forceCasMiss({ db, pool, repo }, { variantId: SKU, quantity: 1 });

      // Distinct from a real shortfall — the boundary can answer 409 "retry" vs a hard sold-out.
      expect(result.status).toBe('rejected');
      const reason = result.status === 'rejected' ? result.reason : undefined;
      expect(reason).toBeInstanceOf(ReservationConflictError);
      expect(reason).not.toBeInstanceOf(InsufficientStockError);

      const stock = await readStock(db, SKU);
      expect(stock.quantityReserved).toBe(1); // only A's hold committed; B rolled back
      expect(stock.version).toBe(1);
      expect(await countHeldReservations(app, SKU)).toBe(1);
    });
  });
});
