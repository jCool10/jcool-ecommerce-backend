import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { FinalizeOrderUseCase } from '../../src/modules/order/application/use-cases';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { readOrder, readReservation, readStock } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

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
    ({ app, pool, db } = await createTestAppWithPool());
    finalize = app.get(FinalizeOrderUseCase);
    stock = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function seedPendingOrder(): Promise<string> {
    const [row] = await db
      .insert(schema.orders)
      .values({ userId: USER_ID, status: 'PENDING', currency: 'VND', totalAmount: 100_000, placedAt: new Date() })
      .returning({ id: schema.orders.id });
    return row.id;
  }

  // A real hold, established the way placement does.
  async function hold(orderId: string, variantId: string, quantity: number): Promise<void> {
    await db.transaction((tx) => stock.reservePessimistic(tx, orderId, [{ variantId, quantity }]));
  }

  it('PAID commits the hold: reservation COMMITTED, on-hand drops, order PAID — all in one tx', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    const s = await readStock(app, SKU);
    expect(s.quantityOnHand).toBe(7); // goods shipped for real
    expect(s.quantityReserved).toBe(0);
  });

  it('FAILED releases the hold: reservation RELEASED, on-hand untouched, stock back to available', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    const result = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(app, orderId)).status).toBe('FAILED');
    expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    const s = await readStock(app, SKU);
    expect(s.quantityOnHand).toBe(10); // never left the shelf
    expect(s.quantityReserved).toBe(0);
  });

  it('EXPIRED releases the hold, same as FAILED', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'EXPIRED', reason: 'expired' });

    expect((await readOrder(app, orderId)).status).toBe('EXPIRED');
    expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });

  it('CANCELLED releases the hold, same as FAILED', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'CANCELLED', reason: 'user:cancelled' });

    expect((await readOrder(app, orderId)).status).toBe('CANCELLED');
    expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    expect((await readStock(app, SKU)).quantityReserved).toBe(0);
  });

  it('is idempotent: finalizing PAID twice commits the hold once — on-hand not dropped again', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });
    const again = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(again.status).toBe('noop');
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7); // still 7, not 4
  });

  it('releases the hold once when FAILED is re-applied: stock given back once, not twice', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await hold(orderId, SKU, 3);

    await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });
    const again = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(again.status).toBe('noop');
    expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    const s = await readStock(app, SKU);
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
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    const s = await readStock(app, SKU);
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
    const s = await readStock(app, SKU);
    expect(s.quantityReserved).toBe(0);
    expect(s.quantityOnHand).toBe(10);
  });

  it('finalizes an order that has no reservation: order PAID, stock untouched, no throw', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10); // stock exists, but this order never held any

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    const s = await readStock(app, SKU);
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
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7); // committed once, not 4
  });

  it('commits a multi-SKU order: every line committed and each stock row dropped', async () => {
    const orderId = await seedPendingOrder();
    await seedStock(app, SKU, 10);
    await seedStock(app, SKU_B, 5);
    await hold(orderId, SKU, 3);
    await hold(orderId, SKU_B, 2);

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect((await readReservation(app, orderId, SKU_B)).status).toBe('COMMITTED');
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7);
    expect((await readStock(app, SKU_B)).quantityOnHand).toBe(3);
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
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7); // decremented exactly once
  });

  it('is atomic: a stock resolution that fails the non-negative CHECK rolls back the order flip too', async () => {
    const orderId = await seedPendingOrder();
    // Corrupted hold: a HELD reservation for more than the tracked `reserved`. Releasing it would drive
    // reserved below zero → ck_stock_reserved_nonneg fires, aborting the transaction. The order status
    // flip shares that tx, so it must revert with the stock — proving the two are one unit of work.
    await seedStock(app, SKU, 10, 2);
    await db.insert(schema.reservations).values({ orderId, variantId: SKU, quantity: 5, status: 'HELD' });

    await expect(finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' })).rejects.toThrow();

    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, SKU)).status).toBe('HELD');
    expect((await readStock(app, SKU)).quantityReserved).toBe(2);
  });
});
