import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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
  type ReservationLine,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { readStock } from '../setup/fixtures/order-flow.fixture';
import { releaseOnceBlocked, seedStock } from '../setup/fixtures/inventory.fixture';
import { testId } from '../setup/id-service-stub';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const SKU = testId();
// One order id for both contenders: a duplicate submission, not two orders competing for stock.
const ORDER = testId();
const STOCK = 10;
const QUANTITY = 1;

type Hold = (tx: DrizzleTx, orderId: string, lines: ReservationLine[]) => Promise<void>;

// A holds its transaction open until B is parked on a lock, so B's dedup read has already run. By
// default B parks on A's stock row lock at its CAS write. With `lockStockTable` B parks earlier, at its
// CAS read, so it reads the version A committed and its first CAS wins.
async function raceDuplicateSubmission(
  db: DrizzleDB,
  pool: Pool,
  hold: Hold,
  line: ReservationLine,
  { lockStockTable = false } = {},
): Promise<PromiseSettledResult<void>> {
  let releaseA!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
  let aHasHeld!: () => void;
  const aHeld = new Promise<void>((resolve) => (aHasHeld = resolve));

  const a = db.transaction(async (tx) => {
    if (lockStockTable) {
      await tx.execute(sql`LOCK TABLE stock_levels IN ACCESS EXCLUSIVE MODE`);
    }
    await hold(tx, ORDER, [line]);
    aHasHeld();
    await aMayCommit;
  });
  await aHeld;

  const b = db.transaction(async (tx) => {
    await hold(tx, ORDER, [line]);
  });
  // Observed by the allSettled below; marked handled so an early rejection is not reported elsewhere.
  b.catch(() => {});

  await releaseOnceBlocked(pool, releaseA);
  await a;

  const [bResult] = await Promise.allSettled([b]);
  return bResult;
}

// Driven at the repository: over HTTP the idempotency key already single-flights a submission.
describe('Inventory reserve under a duplicate submission of one order (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: StockRepositoryPort;

  beforeAll(async () => {
    // A non-zero budget lets B retry after losing the CAS, the path on which a duplicate once raised
    // reserved a second time.
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

  it('optimistic: a duplicate that loses the CAS to the first submission holds once and releases cleanly', async () => {
    const result = await raceDuplicateSubmission(db, pool, repo.reserveOptimistic.bind(repo), {
      variantId: SKU,
      quantity: QUANTITY,
    });

    expect(result.status).toBe('fulfilled');

    const stock = await readStock(app, SKU);
    expect(stock.quantityReserved).toBe(QUANTITY);
    expect(stock.version).toBe(1);

    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });

  it('optimistic: a duplicate whose first CAS wins after the first submission committed holds once', async () => {
    const result = await raceDuplicateSubmission(
      db,
      pool,
      repo.reserveOptimistic.bind(repo),
      { variantId: SKU, quantity: QUANTITY },
      { lockStockTable: true },
    );

    expect(result.status).toBe('fulfilled');
    expect((await readStock(app, SKU)).quantityReserved).toBe(QUANTITY);

    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });

  it.each(['reserveOptimistic', 'reservePessimistic'] as const)(
    '%s: a duplicate of the order that took the last unit is not refused as out of stock',
    async (method) => {
      await seedStock(app, SKU, QUANTITY);

      const result = await raceDuplicateSubmission(db, pool, repo[method].bind(repo), {
        variantId: SKU,
        quantity: QUANTITY,
      });

      expect(result.status).toBe('fulfilled');
      expect((await readStock(app, SKU)).quantityReserved).toBe(QUANTITY);
      expect(await holdsFor(ORDER, SKU)).toHaveLength(1);
    },
  );

  // FOR UPDATE queues B behind A, so B's dedup read sees A's committed hold.
  it('pessimistic: the same duplicate submission holds once and releases cleanly', async () => {
    const result = await raceDuplicateSubmission(db, pool, repo.reservePessimistic.bind(repo), {
      variantId: SKU,
      quantity: QUANTITY,
    });

    expect(result.status).toBe('fulfilled');

    const stock = await readStock(app, SKU);
    expect(stock.quantityReserved).toBe(QUANTITY);
    expect(stock.version).toBe(1);

    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });
});
