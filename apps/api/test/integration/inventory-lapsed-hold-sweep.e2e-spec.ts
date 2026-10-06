import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { ReleaseLapsedHoldsUseCase } from '../../src/modules/product/application/stock/release-lapsed-holds.use-case';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { lapseHoldHeader, readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import { lapseReservation, readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const STOCK = 10;
const QUANTITY = 2;
const SWEEP = { batchSize: 50 };

describe('Lapsed participant hold sweep (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let participant: InventoryParticipant;
  let sweep: ReleaseLapsedHoldsUseCase;
  let sku: string;
  let order: string;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    sweep = app.get(ReleaseLapsedHoldsUseCase);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = testId();
    order = testId();
    await seedStock(app, sku, STOCK);
    await participant.tryReserve({
      orderId: order,
      lines: [{ variantId: sku, quantity: QUANTITY }],
      holdUntil: new Date(Date.now() + 60 * 60_000),
    });
  });

  it('releases a hold whose deadline has passed', async () => {
    await lapseHoldHeader(app, order);

    expect(await sweep.execute(SWEEP)).toEqual({ scanned: 1, released: 1, raced: 0, errors: 0 });

    expect((await readReservationOrder(app, order)).status).toBe('RELEASED');
    expect((await reservationsFor(app, order))[0].status).toBe('RELEASED');
    expect((await readStock(app, sku)).quantityReserved).toBe(0);
  });

  it('claims only held orders, not ones already resolved past their deadline', async () => {
    const [committed, released] = [testId(), testId()];
    for (const orderId of [committed, released]) {
      await participant.tryReserve({
        orderId,
        lines: [{ variantId: sku, quantity: 1 }],
        holdUntil: new Date(Date.now() + 60 * 60_000),
      });
    }
    await participant.commit(committed);
    await participant.release(released);
    for (const orderId of [order, committed, released]) {
      await lapseHoldHeader(app, orderId);
    }

    expect(await sweep.execute(SWEEP)).toEqual({ scanned: 1, released: 1, raced: 0, errors: 0 });

    expect((await readReservationOrder(app, committed)).status).toBe('COMMITTED');
    expect((await readReservationOrder(app, released)).status).toBe('RELEASED');
  });

  it('leaves a hold whose deadline is still ahead', async () => {
    expect(await sweep.execute(SWEEP)).toEqual({ scanned: 0, released: 0, raced: 0, errors: 0 });

    expect((await readReservationOrder(app, order)).status).toBe('HELD');
    expect((await readStock(app, sku)).quantityReserved).toBe(QUANTITY);
  });

  it('never touches a lapsed hold placed by the current checkout path', async () => {
    const legacyOrder = testId();
    const stock = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    await db.transaction((tx) => stock.reservePessimistic(tx, legacyOrder, [{ variantId: sku, quantity: 1 }]));
    await lapseReservation(app, legacyOrder);

    expect(await sweep.execute(SWEEP)).toMatchObject({ scanned: 0, released: 0 });

    expect((await reservationsFor(app, legacyOrder))[0].status).toBe('HELD');
    expect((await readStock(app, sku)).quantityReserved).toBe(QUANTITY + 1);
  });

  it('refuses a commit that arrives after the sweep released the hold', async () => {
    await lapseHoldHeader(app, order);
    await sweep.execute(SWEEP);

    expect(await participant.commit(order)).toEqual({ outcome: 'CONFLICT' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
  });
});
