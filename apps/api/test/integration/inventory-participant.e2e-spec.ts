import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  holdStockRowLock,
  readReservationOrder,
  seedStock,
  type StockRowLock,
} from '../setup/fixtures/inventory.fixture';
import { readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { sleep } from '../setup/sleep';

const STOCK = 10;
const QUANTITY = 3;
const TRY_TIMEOUT_MS = 400;

describe.each(['pessimistic', 'optimistic'] as const)(
  'Inventory participant, %s (integration, real Postgres)',
  (strategy) => {
    let app: INestApplication;
    let pool: Pool;
    let participant: InventoryParticipant;
    let sku: string;
    let order: string;
    let holdUntil: Date;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({
        INVENTORY_LOCK_STRATEGY: strategy,
        INVENTORY_TRY_LOCK_TIMEOUT_MS: String(TRY_TIMEOUT_MS),
        METRICS_TOKEN: E2E_METRICS_TOKEN,
      }));
      participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    beforeEach(async () => {
      sku = testId();
      order = testId();
      holdUntil = new Date(Date.now() + 60 * 60_000);
      await seedStock(app, sku, STOCK);
    });

    const tryReserve = (orderId = order, quantity = QUANTITY) =>
      participant.tryReserve({ orderId, lines: [{ variantId: sku, quantity }], holdUntil });

    it('holds the lines until the deadline it was given and fences the order', async () => {
      expect(await tryReserve()).toEqual({ outcome: 'HELD' });

      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: QUANTITY });
      expect(await readReservationOrder(app, order)).toMatchObject({ status: 'HELD', holdUntil });
      const [line] = await reservationsFor(app, order);
      expect(line).toMatchObject({ status: 'HELD', quantity: QUANTITY, expiresAt: holdUntil });
    });

    it('answers a repeated Try with HELD and holds nothing more', async () => {
      await tryReserve();

      expect(await tryReserve()).toEqual({ outcome: 'HELD' });

      expect(await readStock(app, sku)).toMatchObject({ quantityReserved: QUANTITY, version: 1 });
      expect(await reservationsFor(app, order)).toHaveLength(1);
    });

    it('refuses a shortfall and leaves neither header nor hold behind', async () => {
      const result = await tryReserve(order, STOCK + 1);

      expect(result.outcome).toBe('OUT_OF_STOCK');
      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect(await reservationsFor(app, order)).toHaveLength(0);
      expect((await readStock(app, sku)).quantityReserved).toBe(0);
    });

    it('holds none of an order when one of its lines falls short', async () => {
      const short = testId();
      await seedStock(app, short, 1);

      const result = await participant.tryReserve({
        orderId: order,
        lines: [
          { variantId: sku, quantity: QUANTITY },
          { variantId: short, quantity: 2 },
        ],
        holdUntil,
      });

      expect(result.outcome).toBe('OUT_OF_STOCK');
      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect(await reservationsFor(app, order)).toHaveLength(0);
      expect((await readStock(app, sku)).quantityReserved).toBe(0);
    });

    it('commits once, however often the commit arrives', async () => {
      await tryReserve();

      expect(await participant.commit(order)).toEqual({ outcome: 'COMMITTED' });
      expect(await participant.commit(order)).toEqual({ outcome: 'COMMITTED' });

      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK - QUANTITY, quantityReserved: 0 });
      expect((await readReservationOrder(app, order)).status).toBe('COMMITTED');
    });

    it('releases a held order back to the baseline', async () => {
      await tryReserve();

      expect(await participant.release(order)).toEqual({ outcome: 'RELEASED' });

      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
      expect((await readReservationOrder(app, order)).status).toBe('RELEASED');
      expect((await reservationsFor(app, order))[0].status).toBe('RELEASED');
    });

    it('fences an order released before its Try, so the late Try holds nothing', async () => {
      expect(await participant.release(order)).toEqual({ outcome: 'FENCED' });

      expect(await tryReserve()).toEqual({ outcome: 'CONFLICT' });

      expect((await readStock(app, sku)).quantityReserved).toBe(0);
      expect(await reservationsFor(app, order)).toHaveLength(0);
      expect(await readReservationOrder(app, order)).toMatchObject({ status: 'FENCED', holdUntil: null });
    });

    it('refuses to commit a released order and to release a committed one', async () => {
      const committed = testId();
      await tryReserve();
      await tryReserve(committed);
      await participant.release(order);
      await participant.commit(committed);

      expect(await participant.commit(order)).toEqual({ outcome: 'CONFLICT' });
      expect(await participant.release(committed)).toEqual({ outcome: 'CONFLICT' });

      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK - QUANTITY, quantityReserved: 0 });
    });

    it('restocks a committed order once, and refuses one that never committed', async () => {
      await tryReserve();
      expect(await participant.restock(order)).toEqual({ outcome: 'CONFLICT' });
      await participant.commit(order);

      expect(await participant.restock(order)).toEqual({ outcome: 'RESTOCKED' });
      expect(await participant.restock(order)).toEqual({ outcome: 'RESTOCKED' });

      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
      expect((await readReservationOrder(app, order)).status).toBe('RESTOCKED');
      expect((await reservationsFor(app, order))[0].status).toBe('RESTOCKED');
    });

    it('gives up on a Try stuck behind a row lock, leaving nothing and freeing its connection', async () => {
      const holder = await holdStockRowLock(app, sku);
      const watchdog = setTimeout(holder.release, TRY_TIMEOUT_MS * 5);

      try {
        const started = Date.now();
        const result = await tryReserve();

        expect(result).toEqual({ outcome: 'CONTENDED', detail: expect.stringMatching(/within \d+ms/) });
        expect(Date.now() - started).toBeLessThan(TRY_TIMEOUT_MS * 5);
        expect(await readReservationOrder(app, order)).toBeUndefined();
        // Only the holder's client is still checked out.
        expect(pool.totalCount - pool.idleCount).toBe(1);
      } finally {
        clearTimeout(watchdog);
        holder.release();
        await holder.done;
      }
      expect((await readStock(app, sku)).quantityReserved).toBe(0);
    });

    // Each wait alone fits the budget; only a shared budget refuses the Try.
    it('spends one budget across every lock wait of a Try, not one per row', async () => {
      const other = testId();
      await seedStock(app, other, STOCK);
      const lockOrder = [sku, other].sort((a, b) => a.localeCompare(b));
      const holders: StockRowLock[] = [];
      const eachWaitMs = TRY_TIMEOUT_MS * 0.7;

      try {
        for (const variantId of lockOrder) {
          holders.push(await holdStockRowLock(app, variantId));
        }
        const started = Date.now();
        const settled = participant
          .tryReserve({
            orderId: order,
            lines: lockOrder.map((variantId) => ({ variantId, quantity: 1 })),
            holdUntil,
          })
          .then((result) => ({ result, elapsedMs: Date.now() - started }));
        for (const holder of holders) {
          await sleep(eachWaitMs);
          holder.release();
        }
        const { result, elapsedMs } = await settled;

        expect(result.outcome).toBe('CONTENDED');
        expect(elapsedMs).toBeLessThan(TRY_TIMEOUT_MS * 2);
        expect(await readReservationOrder(app, order)).toBeUndefined();
        expect(await reservationsFor(app, order)).toHaveLength(0);
      } finally {
        holders.forEach((holder) => holder.release());
        await Promise.all(holders.map((holder) => holder.done));
      }
      for (const variantId of lockOrder) {
        expect((await readStock(app, variantId)).quantityReserved).toBe(0);
      }
    });

    it('counts its answers on tcc_branch_total', async () => {
      await tryReserve();

      const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

      expect(text).toMatch(/^tcc_branch_total\{participant="inventory",op="try",outcome="ok"\} [1-9]/m);
    });
  },
);
