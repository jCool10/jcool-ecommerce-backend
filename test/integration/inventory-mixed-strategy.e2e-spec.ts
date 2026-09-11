import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { ReserveStockUseCase } from '../../src/modules/inventory/application/reserve-stock.use-case';
import { StockReservationError } from '../../src/modules/inventory/application/public/stock-reservation.port';
import {
  countHeldReservations,
  getStockView,
  releaseOnceBlocked,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const SKU = '55555555-5555-4555-8555-555555555555';
const ORDER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORDER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
// The last unit: the only quantity where a strategy that blind-writes shows up as an oversell rather
// than as a harmless extra hold.
const LAST_UNIT = 1;

// The holder is idle-in-transaction, not "active", so the single active Lock-waiter is the
// contender — parked on the holder's row lock, which is the happens-before this race needs instead
// of a timing guess. See `waitUntilBlockedOnLock` for why it is scoped to this worker's database.

interface Instance {
  db: DrizzleDB;
  reserve: ReserveStockUseCase;
}

/**
 * `holder` takes the last unit and keeps its transaction open until `contender` is provably parked on
 * its row lock, then commits. The contender therefore re-evaluates against a shelf that is already
 * empty — which is the whole question: does it read the committed state, or write over it?
 */
async function raceForTheLastUnit(
  holder: Instance,
  contender: Instance,
  pool: Pool,
): Promise<PromiseSettledResult<void>> {
  let releaseHolder!: () => void;
  const holderMayCommit = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderHasHeld!: () => void;
  const holderHeld = new Promise<void>((resolve) => (holderHasHeld = resolve));

  const first = holder.db.transaction(async (tx) => {
    await holder.reserve.reserve(tx, ORDER_A, [{ variantId: SKU, quantity: LAST_UNIT }]);
    holderHasHeld();
    await holderMayCommit;
  });
  await holderHeld;

  const second = contender.db.transaction(async (tx) => {
    await contender.reserve.reserve(tx, ORDER_B, [{ variantId: SKU, quantity: LAST_UNIT }]);
  });
  // The contender is expected to reject, and it is not observed until the `allSettled` below.
  // Marking it handled at creation keeps a failure before that point from surfacing as an unhandled
  // rejection at pool teardown, which would report in a different test than the one at fault.
  second.catch(() => {});

  await releaseOnceBlocked(pool, releaseHolder);
  await first;

  const [result] = await Promise.allSettled([second]);
  return result;
}

/**
 * A rolling deploy runs both `INVENTORY_LOCK_STRATEGY` values against one database for the length of
 * the overlap window, so the strategies have to be safe against EACH OTHER and not only against
 * themselves. Two apps rather than two repository calls on purpose: the strategy is a config
 * decision made per instance, and this is the only way to put two instances on one SKU.
 */
describe('Inventory reserve across a mixed-strategy fleet (integration, real Postgres)', () => {
  let pessimistic: INestApplication;
  let optimistic: INestApplication;
  let pool: Pool;
  let pessimisticInstance: Instance;
  let optimisticInstance: Instance;

  beforeAll(async () => {
    pessimistic = await createTestApp({ INVENTORY_LOCK_STRATEGY: 'pessimistic' });
    // Pinned rather than defaulted only so the run does not depend on a local `.env`. Unlike the
    // dedup-race file, the budget cannot change this file's outcome: the contender fights over the
    // LAST unit, so once the holder commits `available` is 0 and the shortfall check at
    // stock.repository.ts:144-146 throws OUT_OF_STOCK before the budget check at :147-149 is ever
    // reached — for any budget, including 0.
    optimistic = await createTestApp({ INVENTORY_LOCK_STRATEGY: 'optimistic', INVENTORY_OPTIMISTIC_MAX_RETRIES: '3' });
    pool = pessimistic.get<Pool>(PG_POOL);
    pessimisticInstance = {
      db: pessimistic.get<DrizzleDB>(DRIZZLE),
      reserve: pessimistic.get(ReserveStockUseCase),
    };
    optimisticInstance = { db: optimistic.get<DrizzleDB>(DRIZZLE), reserve: optimistic.get(ReserveStockUseCase) };
  });

  afterAll(async () => {
    await Promise.all([pessimistic.close(), optimistic.close()]);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedStock(pessimistic, SKU, LAST_UNIT);
  });

  /** The loser must lose in the domain, not at the `ck_stock_no_oversell` backstop. */
  async function expectSoldOutWithoutOverselling(result: PromiseSettledResult<void>): Promise<void> {
    expect(result.status).toBe('rejected');
    const reason = result.status === 'rejected' ? result.reason : undefined;
    expect(reason).toBeInstanceOf(StockReservationError);
    expect(reason).toMatchObject({ reason: 'OUT_OF_STOCK' });

    expect(await getStockView(pessimistic, SKU)).toEqual({ onHand: LAST_UNIT, reserved: LAST_UNIT, available: 0 });
    expect(await countHeldReservations(pessimistic, SKU)).toBe(1);
    const rows = await pessimisticInstance.db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.variantId, SKU));
    expect(rows.map((row) => row.orderId)).toEqual([ORDER_A]);
  }

  // GUARD — the code holds this today; the test is here because nothing asserted it.
  // The optimistic CAS reads the version unlocked, so on paper it could write over a hold taken by a
  // pessimistic instance it never sees. It cannot: its UPDATE parks on the same row lock, and once
  // that clears both the version and the `on_hand - reserved >= q` predicate are re-evaluated against
  // the committed row, so the retry re-reads a shelf with nothing left on it.
  it('an optimistic instance loses the last unit to a pessimistic holder and refuses instead of overselling', async () => {
    const result = await raceForTheLastUnit(pessimisticInstance, optimisticInstance, pool);

    await expectSoldOutWithoutOverselling(result);
  });

  // GUARD, the other deploy order — during an overlap window either instance can be the one holding.
  // Here the holder's uncommitted CAS write is what the pessimistic `SELECT ... FOR UPDATE` parks on.
  it('a pessimistic instance loses the last unit to an optimistic holder and refuses instead of overselling', async () => {
    const result = await raceForTheLastUnit(optimisticInstance, pessimisticInstance, pool);

    await expectSoldOutWithoutOverselling(result);
  });
});
