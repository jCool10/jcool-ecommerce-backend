import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  PRODUCT_STOCK_RESERVATION,
  type ProductStockReservation,
} from '../../src/modules/product/application/public/product-stock-reservation.port';
import { ReleaseLapsedHoldsUseCase } from '../../src/modules/product/application/stock/release-lapsed-holds.use-case';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import {
  getStockView,
  holdRowLock,
  lapseHoldHeader,
  readReservationOrder,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { lapseReservation, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const BUDGET_MS = 1_000;
const BATCH = { batchSize: 50 };

describe('Lapsed participant hold sweep (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let participant: InventoryParticipant;
  let sweep: ReleaseLapsedHoldsUseCase;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS) }));
    participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    sweep = app.get(ReleaseLapsedHoldsUseCase);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function heldOrder(sku: string): Promise<string> {
    const order = testId();
    const holdUntil = new Date(Date.now() + 60 * 60_000);
    expect(await participant.tryReserve({ orderId: order, lines: [{ variantId: sku, quantity: 2 }], holdUntil })).toBe(
      'RESERVED',
    );
    return order;
  }

  it('releases a hold past its hold_until back to baseline', async () => {
    const sku = testId();
    await seedStock(app, sku, 5);
    const order = await heldOrder(sku);
    await lapseHoldHeader(app, order);

    expect(await sweep.execute(BATCH)).toEqual({ scanned: 1, released: 1, raced: 0, errors: 0 });

    expect((await readReservationOrder(app, order))?.status).toBe('RELEASED');
    expect((await getStockView(app, sku))?.reserved).toBe(0);
  });

  it('leaves a hold that is still within its hold_until', async () => {
    const sku = testId();
    await seedStock(app, sku, 5);
    const order = await heldOrder(sku);

    expect((await sweep.execute(BATCH)).scanned).toBe(0);

    expect((await readReservationOrder(app, order))?.status).toBe('HELD');
    expect((await getStockView(app, sku))?.reserved).toBe(2);
  });

  // Those belong to checkout's own sweep, which settles the order along with the stock.
  it('never touches a lapsed reservation placed through the in-transaction port', async () => {
    const [order, sku] = [testId(), testId()];
    await seedStock(app, sku, 5);
    const legacy = app.get<ProductStockReservation>(PRODUCT_STOCK_RESERVATION);
    await db.transaction((tx) => legacy.reserve(tx, order, [{ variantId: sku, quantity: 2 }]));
    await lapseReservation(app, order);

    expect((await sweep.execute(BATCH)).scanned).toBe(0);

    expect((await reservationsFor(app, order)).map((line) => line.status)).toEqual(['HELD']);
    expect((await getStockView(app, sku))?.reserved).toBe(2);
  });

  it('turns a commit arriving after the sweep into a conflict', async () => {
    const sku = testId();
    await seedStock(app, sku, 5);
    const order = await heldOrder(sku);
    await lapseHoldHeader(app, order);
    await sweep.execute(BATCH);

    expect(await participant.commit(order)).toBe('CONFLICT');
    expect(await getStockView(app, sku)).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('steps over a header another transaction holds, and releases it on a later tick', async () => {
    const sku = testId();
    await seedStock(app, sku, 5);
    const order = await heldOrder(sku);
    await lapseHoldHeader(app, order);
    const unlock = await holdRowLock(pool, 'SELECT 1 FROM reservation_orders WHERE order_id = $1 FOR UPDATE', [order]);

    try {
      const started = Date.now();
      expect(await sweep.execute(BATCH)).toEqual({ scanned: 1, released: 0, raced: 1, errors: 0 });
      expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    } finally {
      await unlock();
    }

    expect(await sweep.execute(BATCH)).toEqual({ scanned: 1, released: 1, raced: 0, errors: 0 });
    expect((await getStockView(app, sku))?.reserved).toBe(0);
  });
});
