import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { FinalizeOrderUseCase } from '../../src/modules/order/application/use-cases';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Fixed valid UUIDs — order_id / variant_id are uuid columns.
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const SKU = '11111111-1111-4111-8111-111111111111';
const SKU_B = '22222222-2222-4222-8222-222222222222';

// Stock resolution over real Postgres, in the SAME transaction as the order status flip. Proves the
// money = stock = status invariant: no PAID order leaves stock held, no FAILED order leaves it
// committed, and a failure anywhere rolls back both together.
describe('Order finalization stock resolution (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let finalize: FinalizeOrderUseCase;
  let stock: StockRepositoryPort;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    finalize = app.get(FinalizeOrderUseCase);
    stock = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  async function seedPendingOrder(): Promise<string> {
    const [row] = await db
      .insert(schema.orders)
      .values({ userId: USER_ID, status: 'PENDING', currency: 'VND', totalAmount: 100_000, placedAt: new Date() })
      .returning({ id: schema.orders.id });
    return row.id;
  }

  // Establish a real HELD hold the way placement does — raises reserved, writes a HELD reservation row.
  async function hold(orderId: string, variantId: string, quantity: number): Promise<void> {
    await db.transaction((tx) => stock.reservePessimistic(tx, orderId, [{ variantId, quantity }]));
  }

  async function readStock(variantId: string) {
    const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  async function readReservation(orderId: string, variantId: string) {
    const [row] = await db
      .select()
      .from(schema.reservations)
      .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.variantId, variantId)));
    return row;
  }

  async function readOrder(id: string) {
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
    return row;
  }

  it('PAID commits the hold: reservation COMMITTED, on-hand drops, order PAID — all in one tx', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readReservation(orderId, SKU)).status).toBe('COMMITTED');
    const s = await readStock(SKU);
    expect(s.quantityOnHand).toBe(7); // goods shipped for real
    expect(s.quantityReserved).toBe(0); // hold cleared
  });

  it('FAILED releases the hold: reservation RELEASED, on-hand untouched, stock back to available', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    const result = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(orderId)).status).toBe('FAILED');
    expect((await readReservation(orderId, SKU)).status).toBe('RELEASED');
    const s = await readStock(SKU);
    expect(s.quantityOnHand).toBe(10); // never left the shelf
    expect(s.quantityReserved).toBe(0); // hold returned to available
  });

  it('EXPIRED releases the hold, same as FAILED', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'EXPIRED', reason: 'expired' });

    expect((await readOrder(orderId)).status).toBe('EXPIRED');
    expect((await readReservation(orderId, SKU)).status).toBe('RELEASED');
    expect((await readStock(SKU)).quantityReserved).toBe(0);
  });

  it('CANCELLED releases the hold, same as FAILED', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'CANCELLED', reason: 'user:cancelled' });

    expect((await readOrder(orderId)).status).toBe('CANCELLED');
    expect((await readReservation(orderId, SKU)).status).toBe('RELEASED');
    expect((await readStock(SKU)).quantityReserved).toBe(0);
  });

  it('is idempotent: finalizing PAID twice commits the hold once — on-hand not dropped again', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });
    const again = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(again.status).toBe('noop');
    expect((await readReservation(orderId, SKU)).status).toBe('COMMITTED');
    expect((await readStock(SKU)).quantityOnHand).toBe(7); // still 7, not 4
  });

  it('releases the hold once when FAILED is re-applied: stock given back once, not twice', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });
    const again = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(again.status).toBe('noop');
    expect((await readReservation(orderId, SKU)).status).toBe('RELEASED');
    const s = await readStock(SKU);
    expect(s.quantityReserved).toBe(0); // not -3
    expect(s.quantityOnHand).toBe(10);
  });

  it('does not un-commit a PAID order when a conflicting FAILED arrives late', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });
    const late = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    // The terminal guard returns before the resolution branch, so compensation never runs on a
    // settled order — goods already shipped must not be handed back to available.
    expect(late.status).toBe('ignored');
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readReservation(orderId, SKU)).status).toBe('COMMITTED');
    const s = await readStock(SKU);
    expect(s.quantityOnHand).toBe(7);
    expect(s.quantityReserved).toBe(0);
  });

  it('reservation-status CAS makes releaseReservations idempotent on its own — no double give-back', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    // Twice through the resolver directly, past the order-level terminal guard: without the per-line
    // CAS the second call would give the 3 units back again and drive `reserved` negative.
    const first = await db.transaction((tx) => stock.releaseReservations(tx, orderId));
    const second = await db.transaction((tx) => stock.releaseReservations(tx, orderId));

    expect(first).toMatchObject({ applied: true, alreadyResolved: false, count: 1 });
    expect(second).toMatchObject({ applied: false, alreadyResolved: true, count: 0 });
    const s = await readStock(SKU);
    expect(s.quantityReserved).toBe(0);
    expect(s.quantityOnHand).toBe(10);
  });

  it('finalizes an order that has no reservation: order PAID, stock untouched, no throw', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10); // stock exists, but this order never held any

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(orderId)).status).toBe('PAID');
    const s = await readStock(SKU);
    expect(s.quantityOnHand).toBe(10);
    expect(s.quantityReserved).toBe(0);
  });

  it('commits the hold exactly once under concurrent finalizers of the same order', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    const [a, b] = await Promise.all([
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['finalized', 'noop']);
    expect((await readReservation(orderId, SKU)).status).toBe('COMMITTED');
    expect((await readStock(SKU)).quantityOnHand).toBe(7); // committed once, not 4
  });

  it('commits a multi-SKU order: every line committed and each stock row dropped', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await seedStock(app, SKU_B, 5);
    await hold(orderId, SKU, 3);
    await hold(orderId, SKU_B, 2);

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readReservation(orderId, SKU)).status).toBe('COMMITTED');
    expect((await readReservation(orderId, SKU_B)).status).toBe('COMMITTED');
    expect((await readStock(SKU)).quantityOnHand).toBe(7);
    expect((await readStock(SKU_B)).quantityOnHand).toBe(3);
  });

  it('reservation-status CAS makes commitReservations idempotent on its own — no double decrement', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    // Call the resolver twice directly, bypassing the order-level terminal guard, to exercise the
    // per-line CAS gate itself: the second call finds no HELD row and moves no stock.
    const first = await db.transaction((tx) => stock.commitReservations(tx, orderId));
    const second = await db.transaction((tx) => stock.commitReservations(tx, orderId));

    expect(first).toMatchObject({ applied: true, alreadyResolved: false, count: 1 });
    expect(second).toMatchObject({ applied: false, alreadyResolved: true, count: 0 });
    expect((await readStock(SKU)).quantityOnHand).toBe(7); // decremented exactly once
  });

  it('is atomic: a stock resolution that fails the non-negative CHECK rolls back the order flip too', async () => {
    const orderId = await seedPendingOrder();
    // Corrupted hold: a HELD reservation for more than the tracked `reserved`. Releasing it would drive
    // reserved below zero → ck_stock_reserved_nonneg fires, aborting the transaction. The order status
    // flip shares that tx, so it must revert with the stock — proving the two are one unit of work.
    await seedStock(app, SKU, 10, 2);
    await db.insert(schema.reservations).values({ orderId, variantId: SKU, quantity: 5, status: 'HELD' });

    await expect(finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' })).rejects.toThrow();

    expect((await readOrder(orderId)).status).toBe('PENDING'); // flip rolled back
    expect((await readReservation(orderId, SKU)).status).toBe('HELD'); // hold untouched
    expect((await readStock(SKU)).quantityReserved).toBe(2); // stock unchanged
  });
});
