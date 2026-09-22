import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import {
  STOCK_REPOSITORY,
  type ReserveLine,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { InsufficientStockError } from '../../src/modules/inventory/domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../src/modules/inventory/domain/errors/reservation-conflict.error';
import { countHeldReservations, releaseOnceBlocked, seedStock } from '../setup/fixtures/inventory.fixture';
import { readStock } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// The two optimistic branches a single-thread test can't reach: they only fire when a CAS actually
// loses a version race, which `forceCasMiss` below makes deterministic. Stock is seeded well above
// demand so a miss can never be mistaken for out-of-stock; the shortfall branch (real out-of-stock
// → no retry) is the single-thread case in inventory-optimistic-reserve.e2e-spec.ts.
const SKU = '33333333-3333-4333-8333-333333333333';
const ORDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Contenders {
  db: DrizzleDB;
  pool: Pool;
  repo: StockRepositoryPort;
}

// A is idle-in-transaction, not "active", so a single active Lock-waiter is B — parked on A's row
// lock, which means B has already read the stale version. That happens-before replaces a timing
// guess: A only commits once B is provably committed to the stale version.

/**
 * A reserves then holds its tx open (row lock + uncommitted version bump); B reserves against the
 * still-committed stale version and parks on A's row lock. A commits only once B provably has, so
 * B's `WHERE version = stale` is guaranteed to match nothing. B is settled inside, so no rejected
 * promise is left unobserved.
 */
async function forceCasMiss({ db, pool, repo }: Contenders, line: ReserveLine): Promise<PromiseSettledResult<void>> {
  let releaseA!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
  let aReserved!: () => void;
  const aHasReserved = new Promise<void>((resolve) => (aReserved = resolve));

  const a = db.transaction(async (tx) => {
    await repo.reserveOptimistic(tx, ORDER_A, [line]);
    aReserved();
    await aMayCommit; // hold the tx open so B contends against the stale version
  });
  await aHasReserved;

  const b = db.transaction(async (tx) => {
    await repo.reserveOptimistic(tx, ORDER_B, [line]);
  });
  // B is expected to reject, and it is not observed until the `allSettled` below. Marking it handled
  // at creation keeps a failure before that point from surfacing as an unhandled rejection at pool
  // teardown, which would report in a different test than the one at fault.
  b.catch(() => {});

  await releaseOnceBlocked(pool, releaseA, { subject: 'B' });
  await a; // A commits: version moves, so B's `WHERE version = stale` will match nothing

  const [bResult] = await Promise.allSettled([b]);
  return bResult;
}

describe('Inventory optimistic reserve under version contention (integration, real Postgres)', () => {
  describe('with a retry budget (default INVENTORY_OPTIMISTIC_MAX_RETRIES)', () => {
    let app: INestApplication;
    let pool: Pool;
    let db: DrizzleDB;
    let repo: StockRepositoryPort;

    beforeAll(async () => {
      ({ app, pool, db } = await createTestAppWithPool({ INVENTORY_LOCK_STRATEGY: 'optimistic' }));
      repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it('a writer that loses the CAS retries against the new version and still holds', async () => {
      await seedStock(app, SKU, 10); // ample: the miss is pure contention, never a shortfall

      // The no-retry sibling below is the canary: if forcing ever failed to force, that one goes
      // red. So reaching reserved=2 here means B recovered via retry, not that it never contended.
      const result = await forceCasMiss({ db, pool, repo }, { variantId: SKU, quantity: 1 });
      expect(result.status).toBe('fulfilled');

      const stock = await readStock(app, SKU);
      expect(stock.quantityReserved).toBe(2);
      expect(stock.version).toBe(2); // one bump per winning CAS (A, then B's retry)
      expect(stock.quantityOnHand - stock.quantityReserved).toBe(8);
      expect(await countHeldReservations(app, SKU)).toBe(2);
    });
  });

  describe('with no retry budget (INVENTORY_OPTIMISTIC_MAX_RETRIES=0)', () => {
    let app: INestApplication;
    let pool: Pool;
    let db: DrizzleDB;
    let repo: StockRepositoryPort;

    // A second boot, not a second test: the retry budget is read when the module compiles, and
    // "recovered via retry" and "gave up with no retries" are the same code path under two budgets.
    beforeAll(async () => {
      ({ app, pool, db } = await createTestAppWithPool({
        INVENTORY_LOCK_STRATEGY: 'optimistic',
        INVENTORY_OPTIMISTIC_MAX_RETRIES: '0',
      }));
      repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it('a losing CAS with no retries fails as ReservationConflictError, not InsufficientStock', async () => {
      await seedStock(app, SKU, 10); // ample stock: the failure must be contention, not a shortfall

      const result = await forceCasMiss({ db, pool, repo }, { variantId: SKU, quantity: 1 });

      // Distinct from a real shortfall — the boundary can answer 409 "retry" vs a hard sold-out.
      expect(result.status).toBe('rejected');
      const reason = result.status === 'rejected' ? result.reason : undefined;
      expect(reason).toBeInstanceOf(ReservationConflictError);
      expect(reason).not.toBeInstanceOf(InsufficientStockError);

      const stock = await readStock(app, SKU);
      expect(stock.quantityReserved).toBe(1); // only A's hold committed; B rolled back
      expect(stock.version).toBe(1);
      expect(await countHeldReservations(app, SKU)).toBe(1);
    });
  });
});
