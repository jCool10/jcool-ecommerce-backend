import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DRIZZLE,
  PG_POOL,
  type DrizzleDB,
  type DrizzleTx,
} from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  STOCK_REPOSITORY,
  type ReserveLine,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { readStock } from '../setup/fixtures/order-flow.fixture';
import { releaseOnceBlocked, seedStock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const SKU = '44444444-4444-4444-8444-444444444444';
// ONE order id for both contenders — this suite is about a duplicate submission of the same order,
// not about two orders competing for stock (that is inventory-optimistic-contention.e2e-spec.ts).
const ORDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STOCK = 10;
const QUANTITY = 1;

type Hold = (tx: DrizzleTx, orderId: string, lines: ReserveLine[]) => Promise<void>;

// A is idle-in-transaction, not "active", so the single active Lock-waiter is B — parked on the row
// lock A holds, which means B has already run whatever it does before touching that row. See
// `waitUntilBlockedOnLock` for why the count is scoped to this worker's database.

/**
 * Two transactions submit the SAME order for the SAME SKU at once. A holds its transaction open
 * until B is provably parked on the row lock, so B's own dedup read has already run and found
 * nothing — the exact interleaving a duplicate submission produces. B is settled inside, so no
 * rejected promise is left unobserved.
 */
async function raceDuplicateSubmission(
  db: DrizzleDB,
  pool: Pool,
  hold: Hold,
  line: ReserveLine,
): Promise<PromiseSettledResult<void>> {
  let releaseA!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
  let aHasHeld!: () => void;
  const aHeld = new Promise<void>((resolve) => (aHasHeld = resolve));

  const a = db.transaction(async (tx) => {
    await hold(tx, ORDER, [line]);
    aHasHeld();
    await aMayCommit;
  });
  await aHeld;

  const b = db.transaction(async (tx) => {
    await hold(tx, ORDER, [line]);
  });
  // B is expected to reject on some paths, and it is not observed until the `allSettled` below.
  // Marking it handled at creation keeps a failure before that point from surfacing as an
  // unhandled rejection at pool teardown, which would report in a different test than the one at fault.
  b.catch(() => {});

  await releaseOnceBlocked(pool, releaseA);
  await a;

  const [bResult] = await Promise.allSettled([b]);
  return bResult;
}

/**
 * Unreachable over HTTP today — the `(user_id, idempotency_key)` unique index single-flights order
 * submission — so both strategies are driven at the repository, which is where the contract lives.
 * `INVENTORY_LOCK_STRATEGY` only picks which of these two methods `ReserveStockUseCase` calls, so
 * one app covers both halves and the contrast between them stays in one file.
 */
describe('Inventory reserve under a duplicate submission of one order (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: StockRepositoryPort;

  beforeAll(async () => {
    // Pinned, not defaulted: with a zero budget B fails the CAS outright and never reaches the
    // second hold, which is the behaviour this file exists to pin.
    app = await createTestApp({ INVENTORY_OPTIMISTIC_MAX_RETRIES: '3' });
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedStock(app, SKU, STOCK);
  });

  const holdsFor = (orderId: string, variantId: string) =>
    db
      .select()
      .from(schema.reservations)
      .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.variantId, variantId)));

  const release = (orderId: string) => db.transaction((tx) => repo.releaseReservations(tx, orderId));

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: two concurrent `reserveOptimistic` calls for the same (order, SKU) raise
  //   `quantity_reserved` by the line quantity exactly ONCE, the same way a sequential repeat does.
  // Violated at: src/modules/inventory/infrastructure/stock.repository.ts:76-86 — the dedup read is
  //   not lock-guarded (the optimistic path holds no row lock at that point), so both callers miss
  //   it and each runs a CAS, while `onConflictDoNothing` at :90-93 writes only ONE reservation row.
  //   The port doc at src/modules/inventory/application/ports/stock-repository.port.ts:27-33 states
  //   the hazard as a caller obligation; nothing in the code enforces it.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — INV-1 (and matrix q1: whether
  //   `reserveOptimistic` should take the row lock before its dedup read, which costs the strategy
  //   its reason to exist).
  it('optimistic: a duplicate submission raises reserved twice and leaks the surplus forever', async () => {
    const result = await raceDuplicateSubmission(db, pool, repo.reserveOptimistic.bind(repo), {
      variantId: SKU,
      quantity: QUANTITY,
    });

    expect(result.status).toBe('fulfilled');

    // Two CAS wins, so two units are held — for one order that only ever asked for one.
    const stock = await readStock(app, SKU);
    expect(stock.quantityReserved).toBe(2 * QUANTITY);
    expect(stock.version).toBe(2);

    // ...backed by a single reservation row, because the insert is unique on (order, SKU).
    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    // The consequence, and the reason this is Critical: resolving the order gives back what the ONE
    // row says, so the second CAS's unit is stranded with nothing left that could ever release it.
    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(QUANTITY);
    expect(await holdsFor(ORDER, SKU)).toHaveLength(1);
  });

  // The contrast that makes the finding above legible: the same race, the same order, the other
  // strategy. `FOR UPDATE` at stock.repository.ts:35 serializes B behind A, so B's dedup read runs
  // AFTER A committed and sees the hold — the guarantee the optimistic path documents but cannot keep.
  it('pessimistic: the same duplicate submission holds exactly once and releases cleanly', async () => {
    const result = await raceDuplicateSubmission(db, pool, repo.reservePessimistic.bind(repo), {
      variantId: SKU,
      quantity: QUANTITY,
    });

    expect(result.status).toBe('fulfilled');

    const stock = await readStock(app, SKU);
    expect(stock.quantityReserved).toBe(QUANTITY);
    expect(stock.version).toBe(1); // one bump, because only one caller wrote

    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });
});
