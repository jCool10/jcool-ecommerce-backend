import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { FinalizeOrderUseCase } from '../../src/modules/order/application/use-cases';
import { OrderCancelledEvent } from '../../src/modules/order/domain/events/order-cancelled.event';
import { OrderExpiredEvent } from '../../src/modules/order/domain/events/order-expired.event';
import { OrderFailedEvent } from '../../src/modules/order/domain/events/order-failed.event';
import { OrderPaidEvent } from '../../src/modules/order/domain/events/order-paid.event';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { readOrder, readReservation, readStock } from '../setup/fixtures/order-flow.fixture';
import { mintTestUserId } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const USER_ID = mintTestUserId('owner@test.local');
const SKU = '11111111-1111-4111-8111-111111111111';
const SKU_B = '22222222-2222-4222-8222-222222222222';

// The order status flip and the stock resolution share one transaction.
describe('Order finalization (integration, real Postgres)', () => {
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

  async function seedOrder(status: 'DRAFT' | 'PENDING' = 'PENDING'): Promise<string> {
    const [row] = await db
      .insert(schema.orders)
      .values({
        userId: USER_ID,
        status,
        currency: 'VND',
        totalAmount: 100_000,
        placedAt: status === 'PENDING' ? new Date() : null,
      })
      .returning({ id: schema.orders.id });
    return row.id;
  }

  async function hold(orderId: string, variantId: string, quantity: number): Promise<void> {
    await db.transaction((tx) => stock.reservePessimistic(tx, orderId, [{ variantId, quantity }]));
  }

  async function orderHolding(quantity: number, variantId = SKU): Promise<string> {
    const orderId = await seedOrder();
    await hold(orderId, variantId, quantity);
    return orderId;
  }

  it('commits the hold and stamps the order when PAID', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await orderHolding(3);

    const result = await finalize.execute({ orderId, outcome: 'PAID', reason: 'webhook:paid', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect(result.event).toBeInstanceOf(OrderPaidEvent);
    expect(result.event).toMatchObject({ aggregateId: orderId, paymentRef: 'pay_1' });
    const row = await readOrder(app, orderId);
    expect(row).toMatchObject({ status: 'PAID', finalizeReason: 'webhook:paid', paymentRef: 'pay_1' });
    expect(row.finalizedAt).not.toBeNull();
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });
  });

  it('releases the hold for every unpaid outcome, each with its own event', async () => {
    await seedStock(app, SKU, 10);
    const outcomes = [
      ['FAILED', OrderFailedEvent],
      ['EXPIRED', OrderExpiredEvent],
      ['CANCELLED', OrderCancelledEvent],
    ] as const;

    for (const [outcome, event] of outcomes) {
      const orderId = await orderHolding(3);

      const result = await finalize.execute({ orderId, outcome, reason: `test:${outcome}` });

      expect(result.event).toBeInstanceOf(event);
      expect(await readOrder(app, orderId)).toMatchObject({ status: outcome, finalizeReason: `test:${outcome}` });
      expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    }
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it('commits the hold once when PAID is applied twice', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await orderHolding(3);
    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });
    const firstFinalizedAt = (await readOrder(app, orderId)).finalizedAt;

    const again = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(again.status).toBe('noop');
    expect(again.event).toBeUndefined();
    expect((await readOrder(app, orderId)).finalizedAt).toEqual(firstFinalizedAt);
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7);
  });

  it('gives the stock back once when FAILED is applied twice', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await orderHolding(3);
    await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    const again = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(again.status).toBe('noop');
    expect((await readReservation(app, orderId, SKU)).status).toBe('RELEASED');
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it('keeps a PAID order and its committed stock when FAILED arrives late', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await orderHolding(3);
    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    const late = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(late.status).toBe('ignored');
    expect(await readOrder(app, orderId)).toMatchObject({ status: 'PAID', finalizeReason: null });
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });
  });

  it('ignores an order that is not PENDING', async () => {
    const orderId = await seedOrder('DRAFT');

    const result = await finalize.execute({ orderId, outcome: 'PAID' });

    expect(result.status).toBe('ignored');
    expect((await readOrder(app, orderId)).status).toBe('DRAFT');
  });

  it('finalizes once under two concurrent finalizers', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await orderHolding(3);

    const results = await Promise.all([
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['finalized', 'noop']);
    expect(results.filter((r) => r.event)).toHaveLength(1);
    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7);
  });

  it('finalizes an order that never held stock', async () => {
    await seedStock(app, SKU, 10);
    const orderId = await seedOrder();

    const result = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it('commits every line of a multi-SKU order', async () => {
    await seedStock(app, SKU, 10);
    await seedStock(app, SKU_B, 5);
    const orderId = await orderHolding(3);
    await hold(orderId, SKU_B, 2);

    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect((await readReservation(app, orderId, SKU)).status).toBe('COMMITTED');
    expect((await readReservation(app, orderId, SKU_B)).status).toBe('COMMITTED');
    expect((await readStock(app, SKU)).quantityOnHand).toBe(7);
    expect((await readStock(app, SKU_B)).quantityOnHand).toBe(3);
  });

  // Called past the order-level terminal guard, so only the per-line status CAS stands in the way.
  it('resolves each reservation once even when the resolver runs twice', async () => {
    await seedStock(app, SKU, 10);
    await seedStock(app, SKU_B, 10);
    const committed = await orderHolding(3);
    const released = await orderHolding(3, SKU_B);

    const commits = [
      await db.transaction((tx) => stock.commitReservations(tx, committed)),
      await db.transaction((tx) => stock.commitReservations(tx, committed)),
    ];
    const releases = [
      await db.transaction((tx) => stock.releaseReservations(tx, released)),
      await db.transaction((tx) => stock.releaseReservations(tx, released)),
    ];

    const once = [
      expect.objectContaining({ applied: true, alreadyResolved: false, count: 1 }),
      expect.objectContaining({ applied: false, alreadyResolved: true, count: 0 }),
    ];
    expect(commits).toEqual(once);
    expect(releases).toEqual(once);
    expect(await readStock(app, SKU)).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });
    expect(await readStock(app, SKU_B)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it('rolls the order flip back when the stock resolution fails its CHECK', async () => {
    const orderId = await seedOrder();
    // A HELD line larger than the tracked reserved count: releasing it trips ck_stock_reserved_nonneg.
    await seedStock(app, SKU, 10, 2);
    await db.insert(schema.reservations).values({ orderId, variantId: SKU, quantity: 5, status: 'HELD' });

    await expect(finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' })).rejects.toThrow();

    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, SKU)).status).toBe('HELD');
    expect((await readStock(app, SKU)).quantityReserved).toBe(2);
  });
});
