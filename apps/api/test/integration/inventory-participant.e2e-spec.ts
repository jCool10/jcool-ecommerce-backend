import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import { readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import { readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { sleep } from '../setup/sleep';

const BUDGET_MS = 1_000;

// Holds the rows on a connection of its own until the returned callback commits.
async function lockStockRows(pool: Pool, ...variantIds: string[]): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM stock_levels WHERE variant_id = ANY($1) FOR UPDATE', [variantIds]);
  return async () => {
    await client.query('COMMIT');
    client.release();
  };
}

const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount;

describe.each(['pessimistic', 'optimistic'] as const)('Inventory participant, %s (integration)', (strategy) => {
  let app: INestApplication;
  let pool: Pool;
  let participant: InventoryParticipant;
  let sku: string;
  let orderId: string;
  const holdUntil = () => new Date(Date.now() + 60 * 60_000);

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({
      INVENTORY_LOCK_STRATEGY: strategy,
      INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
    }));
    participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = testId();
    orderId = testId();
    await seedStock(app, sku, 10);
  });

  const tryReserve = (quantity = 3, until = holdUntil()) =>
    participant.tryReserve({ orderId, lines: [{ variantId: sku, quantity }], holdUntil: until });

  it('holds stock under a HELD header and stamps holdUntil on the reservation', async () => {
    const until = holdUntil();

    await expect(tryReserve(3, until)).resolves.toEqual({ outcome: 'HELD' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 10, quantityReserved: 3 });
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: 'HELD', holdUntil: until });
    const [reservation] = await reservationsFor(app, orderId);
    expect(reservation).toMatchObject({ status: 'HELD', quantity: 3, expiresAt: until });
  });

  it('answers a repeat Try with HELD and holds nothing more', async () => {
    await tryReserve();

    await expect(tryReserve()).resolves.toEqual({ outcome: 'HELD' });

    expect((await readStock(app, sku)).quantityReserved).toBe(3);
    expect(await reservationsFor(app, orderId)).toHaveLength(1);
  });

  it('answers a shortfall with OUT_OF_STOCK and leaves no header or hold behind', async () => {
    await expect(tryReserve(11)).resolves.toMatchObject({ outcome: 'OUT_OF_STOCK' });

    expect((await readStock(app, sku)).quantityReserved).toBe(0);
    expect(await readReservationOrder(app, orderId)).toBeUndefined();
    expect(await reservationsFor(app, orderId)).toHaveLength(0);
  });

  it('commits once, however often the commit is repeated', async () => {
    await tryReserve();

    await expect(participant.commit(orderId)).resolves.toEqual({ outcome: 'COMMITTED' });
    await expect(participant.commit(orderId)).resolves.toEqual({ outcome: 'COMMITTED' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: 'COMMITTED' });
  });

  it('gives the held stock back on release', async () => {
    await tryReserve();

    await expect(participant.release(orderId)).resolves.toEqual({ outcome: 'RELEASED' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: 'RELEASED' });
  });

  it('fences an order released before its Try, so the late Try holds nothing', async () => {
    await expect(participant.release(orderId)).resolves.toEqual({ outcome: 'FENCED' });

    await expect(tryReserve()).resolves.toEqual({ outcome: 'CONFLICT' });

    expect((await readStock(app, sku)).quantityReserved).toBe(0);
    expect(await reservationsFor(app, orderId)).toHaveLength(0);
  });

  it('refuses a commit after a release and a release after a commit', async () => {
    const released = orderId;
    await tryReserve();
    await participant.release(released);
    orderId = testId();
    await tryReserve();
    await participant.commit(orderId);

    await expect(participant.commit(released)).resolves.toEqual({ outcome: 'CONFLICT' });
    await expect(participant.release(orderId)).resolves.toEqual({ outcome: 'CONFLICT' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });
  });

  it('restocks a committed order once and refuses to restock one that never committed', async () => {
    await tryReserve();
    await expect(participant.restock(orderId)).resolves.toEqual({ outcome: 'CONFLICT' });
    await participant.commit(orderId);

    await expect(participant.restock(orderId)).resolves.toEqual({ outcome: 'RESTOCKED' });
    await expect(participant.restock(orderId)).resolves.toEqual({ outcome: 'RESTOCKED' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: 'RESTOCKED' });
    const [reservation] = await reservationsFor(app, orderId);
    expect(reservation.status).toBe('RESTOCKED');
  });

  it('answers CONTENDED once a stock row stays locked past the budget, and hands its connection back', async () => {
    const unlock = await lockStockRows(pool, sku);

    const result = await tryReserve().finally(unlock);

    expect(result.outcome).toBe('CONTENDED');
    expect(await readReservationOrder(app, orderId)).toBeUndefined();
    expect((await readStock(app, sku)).quantityReserved).toBe(0);
    expect(checkedOut(pool)).toBe(0);
  });

  it('spends one budget across every lock wait of a multi-line Try, not one per wait', async () => {
    const other = testId();
    await seedStock(app, other, 10);
    // The Try locks rows in this order, so the first one is let go first.
    const [first, second] = [sku, other].sort((a, b) => a.localeCompare(b));
    const unlockFirst = await lockStockRows(pool, first);
    const unlockSecond = await lockStockRows(pool, second);

    const startedAt = Date.now();
    const attempt = participant
      .tryReserve({
        orderId,
        lines: [
          { variantId: first, quantity: 1 },
          { variantId: second, quantity: 1 },
        ],
        holdUntil: holdUntil(),
      })
      .then((result) => ({ result, elapsedMs: Date.now() - startedAt }));
    try {
      await sleep(0.7 * BUDGET_MS);
      await unlockFirst();
      await sleep(0.7 * BUDGET_MS);
    } finally {
      await unlockSecond();
    }
    const { result, elapsedMs } = await attempt;

    expect(result.outcome).toBe('CONTENDED');
    expect(elapsedMs).toBeLessThan(2 * BUDGET_MS);
    expect(await readReservationOrder(app, orderId)).toBeUndefined();
    expect((await readStock(app, first)).quantityReserved).toBe(0);
  });
});
