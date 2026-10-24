import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB, DrizzleTx } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { InsufficientStockError } from '../../src/modules/product/domain/stock/errors/insufficient-stock.error';
import {
  countHeldReservations,
  getStockView,
  releaseOnceBlocked,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { testId } from '../setup/id-service-stub';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const SKU = testId();
const ORDER_A = testId();
const ORDER_B = testId();
// On the last unit a blind write shows up as an oversell rather than an extra hold.
const LAST_UNIT = 1;

type Hold = (tx: DrizzleTx, orderId: string) => Promise<void>;

// The holder commits only once the contender is parked on its row lock, so the contender
// re-evaluates against an empty shelf.
async function raceForTheLastUnit(db: DrizzleDB, pool: Pool, holder: Hold, contender: Hold) {
  let releaseHolder!: () => void;
  const holderMayCommit = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderHasHeld!: () => void;
  const holderHeld = new Promise<void>((resolve) => (holderHasHeld = resolve));

  const first = db.transaction(async (tx) => {
    await holder(tx, ORDER_A);
    holderHasHeld();
    await holderMayCommit;
  });
  await holderHeld;

  const second = db.transaction((tx) => contender(tx, ORDER_B));
  // Observed by the allSettled below; marked handled so an early rejection is not reported elsewhere.
  second.catch(() => {});

  await releaseOnceBlocked(pool, releaseHolder);
  await first;

  const [result] = await Promise.allSettled([second]);
  return result;
}

// A rolling deploy runs both lock strategies against one database, so each must be safe against the
// other. Both live on the repository, so one app races them.
describe('Inventory reserve across a mixed-strategy fleet (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let pessimistic: Hold;
  let optimistic: Hold;

  beforeAll(async () => {
    // Pinned against a local .env; with nothing available the shortfall throws before any retry.
    ({ app, pool, db } = await createTestAppWithPool({ INVENTORY_OPTIMISTIC_MAX_RETRIES: '3' }));
    const repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    const lines = [{ variantId: SKU, quantity: LAST_UNIT }];
    const options = () => ({ expiresAt: new Date(Date.now() + 60 * 60_000), reservationIds: [testId()] });
    pessimistic = (tx, orderId) => repo.reservePessimistic(tx, orderId, lines, options());
    optimistic = (tx, orderId) => repo.reserveOptimistic(tx, orderId, lines, options());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // The loser must lose in the domain, not at the ck_stock_no_oversell backstop.
  async function expectSoldOutWithoutOverselling(result: PromiseSettledResult<void>): Promise<void> {
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' ? result.reason : undefined).toBeInstanceOf(InsufficientStockError);

    expect(await getStockView(app, SKU)).toEqual({ onHand: LAST_UNIT, reserved: LAST_UNIT, available: 0 });
    expect(await countHeldReservations(app, SKU)).toBe(1);
    const rows = await db.select().from(schema.reservations).where(eq(schema.reservations.variantId, SKU));
    expect(rows.map((row) => row.orderId)).toEqual([ORDER_A]);
  }

  // The optimistic UPDATE parks on the holder's row lock and re-evaluates its predicate afterwards.
  it('refuses an optimistic contender for a unit a pessimistic holder took', async () => {
    await seedStock(app, SKU, LAST_UNIT);

    await expectSoldOutWithoutOverselling(await raceForTheLastUnit(db, pool, pessimistic, optimistic));
  });

  it('refuses a pessimistic contender for a unit an optimistic holder took', async () => {
    await seedStock(app, SKU, LAST_UNIT);

    await expectSoldOutWithoutOverselling(await raceForTheLastUnit(db, pool, optimistic, pessimistic));
  });
});
