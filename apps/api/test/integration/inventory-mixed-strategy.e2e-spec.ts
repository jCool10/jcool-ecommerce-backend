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
// On the last unit a blind write shows up as an oversell rather than an extra hold.
const LAST_UNIT = 1;

interface Instance {
  db: DrizzleDB;
  reserve: ReserveStockUseCase;
}

// The holder commits only once the contender is parked on its row lock, so the contender
// re-evaluates against an empty shelf.
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
  // Observed by the allSettled below; marked handled so an early rejection is not reported elsewhere.
  second.catch(() => {});

  await releaseOnceBlocked(pool, releaseHolder);
  await first;

  const [result] = await Promise.allSettled([second]);
  return result;
}

// A rolling deploy runs both lock strategies against one database, so each must be safe against the
// other. The strategy is per-instance config, hence two apps.
describe('Inventory reserve across a mixed-strategy fleet (integration, real Postgres)', () => {
  let pessimistic: INestApplication;
  let optimistic: INestApplication;
  let pool: Pool;
  let pessimisticInstance: Instance;
  let optimisticInstance: Instance;

  beforeAll(async () => {
    pessimistic = await createTestApp({ INVENTORY_LOCK_STRATEGY: 'pessimistic' });
    // Pinned against a local .env; with nothing available the shortfall throws before any retry.
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

  // The loser must lose in the domain, not at the ck_stock_no_oversell backstop.
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

  // The optimistic UPDATE parks on the holder's row lock and re-evaluates its predicate afterwards.
  it('refuses an optimistic contender for a unit a pessimistic holder took', async () => {
    const result = await raceForTheLastUnit(pessimisticInstance, optimisticInstance, pool);

    await expectSoldOutWithoutOverselling(result);
  });

  it('refuses a pessimistic contender for a unit an optimistic holder took', async () => {
    const result = await raceForTheLastUnit(optimisticInstance, pessimisticInstance, pool);

    await expectSoldOutWithoutOverselling(result);
  });
});
