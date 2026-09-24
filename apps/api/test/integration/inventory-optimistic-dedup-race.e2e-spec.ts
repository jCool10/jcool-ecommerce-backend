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
// One order id for both contenders: a duplicate submission, not two orders competing for stock.
const ORDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STOCK = 10;
const QUANTITY = 1;

type Hold = (tx: DrizzleTx, orderId: string, lines: ReserveLine[]) => Promise<void>;

// A holds its transaction open until B is parked on the row lock, so B's dedup read has already run.
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
    // With a zero retry budget B would fail the CAS outright and never reach the second hold.
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

  // Known defect. Intended: concurrent reserveOptimistic calls for one (order, SKU) raise reserved
  // once. Actual: StockRepository.reserveOptimistic reads for a duplicate without a row lock, so both
  // callers win a CAS while the unique insert keeps one reservation row, stranding a unit.
  it('optimistic: a duplicate submission raises reserved twice and leaks the surplus', async () => {
    const result = await raceDuplicateSubmission(db, pool, repo.reserveOptimistic.bind(repo), {
      variantId: SKU,
      quantity: QUANTITY,
    });

    expect(result.status).toBe('fulfilled');

    const stock = await readStock(app, SKU);
    expect(stock.quantityReserved).toBe(2 * QUANTITY);
    expect(stock.version).toBe(2);

    const holds = await holdsFor(ORDER, SKU);
    expect(holds).toHaveLength(1);
    expect(holds[0].quantity).toBe(QUANTITY);

    await release(ORDER);
    expect((await readStock(app, SKU)).quantityReserved).toBe(QUANTITY);
    expect(await holdsFor(ORDER, SKU)).toHaveLength(1);
  });

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
