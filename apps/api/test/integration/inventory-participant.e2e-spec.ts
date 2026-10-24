import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import { ReservationTimeoutError } from '../../src/modules/product/domain/stock/errors/reservation-timeout.error';
import {
  checkedOutConnections,
  getStockView,
  holdRowLock,
  readReservationOrder,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { sleep } from '../setup/sleep';

const BUDGET_MS = 600;
const HOLD_UNTIL = new Date(Date.now() + 2 * 60 * 60_000);
const LOCK_STOCK_ROW = 'SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE';
const LOCK_HEADER = 'SELECT 1 FROM reservation_orders WHERE order_id = $1 FOR UPDATE';

describe('Inventory participant (integration, real Postgres)', () => {
  // First, while no other app in this file has closed: a closed app's gauge collectors stay in the
  // shared registry and log a scrape failure on every /metrics.
  describe('statusOf and metrics', () => {
    let app: INestApplication;
    let pool: Pool;
    let participant: InventoryParticipant;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({ METRICS_TOKEN: E2E_METRICS_TOKEN }));
      participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    const holdOne = (orderId: string, variantId: string) =>
      participant.tryReserve({ orderId, lines: [{ variantId, quantity: 1 }], holdUntil: HOLD_UNTIL });

    it('reports each header, and null for an order that never had one', async () => {
      const [held, committed, fenced, none, sku] = [testId(), testId(), testId(), testId(), testId()];
      await seedStock(app, sku, 5);
      await holdOne(held, sku);
      await holdOne(committed, sku);
      await participant.commit(committed);
      await participant.release(fenced);

      const statuses = await participant.statusOf([held, committed, fenced, none]);

      expect([...statuses]).toEqual([
        [held, 'HELD'],
        [committed, 'COMMITTED'],
        [fenced, 'FENCED'],
        [none, null],
      ]);
    });

    it('answers a full batch, one key per id asked for', async () => {
      const fenced = testId();
      await participant.release(fenced);
      const ids = [fenced, ...Array.from({ length: 199 }, () => testId())];

      const statuses = await participant.statusOf(ids);

      expect(statuses.size).toBe(200);
      expect(statuses.get(fenced)).toBe('FENCED');
      expect([...statuses.values()].filter((status) => status === null)).toHaveLength(199);
    });

    it('answers an empty batch with an empty map', async () => {
      expect((await participant.statusOf([])).size).toBe(0);
    });

    it('reads past a header another transaction holds locked', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await holdOne(order, sku);
      const unlock = await holdRowLock(pool, LOCK_HEADER, [order]);

      try {
        const started = Date.now();
        expect((await participant.statusOf([order])).get(order)).toBe('HELD');
        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      } finally {
        await unlock();
      }
    });

    it('counts commands on /metrics by participant, op and outcome', async () => {
      await participant.release(testId());

      const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

      expect(res.text).toMatch(/tcc_branch_total\{participant="inventory",op="release",outcome="applied"\} [1-9]/);
    });
  });

  describe.each(['pessimistic', 'optimistic'] as const)('%s strategy', (strategy) => {
    let app: INestApplication;
    let pool: Pool;
    let participant: InventoryParticipant;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({
        INVENTORY_LOCK_STRATEGY: strategy,
        INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
      }));
      participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    const tryReserve = (orderId: string, variantId: string, quantity = 2) =>
      participant.tryReserve({ orderId, lines: [{ variantId, quantity }], holdUntil: HOLD_UNTIL });

    it('reserves, writes a HELD header and stamps every line with the hold deadline', async () => {
      const [order, a, b] = [testId(), testId(), testId()];
      await seedStock(app, a, 5);
      await seedStock(app, b, 5);

      const outcome = await participant.tryReserve({
        orderId: order,
        lines: [
          { variantId: a, quantity: 2 },
          { variantId: b, quantity: 1 },
        ],
        holdUntil: HOLD_UNTIL,
      });

      expect(outcome).toBe('RESERVED');
      expect(await getStockView(app, a)).toMatchObject({ onHand: 5, reserved: 2 });
      expect(await getStockView(app, b)).toMatchObject({ onHand: 5, reserved: 1 });
      expect(await readReservationOrder(app, order)).toMatchObject({ status: 'HELD', holdUntil: HOLD_UNTIL });
      const lines = await reservationsFor(app, order);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.expiresAt)).toEqual([HOLD_UNTIL, HOLD_UNTIL]);
    });

    it('answers a repeated Try without reserving twice', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);

      expect(await tryReserve(order, sku)).toBe('RESERVED');
      expect(await tryReserve(order, sku)).toBe('RESERVED');

      expect((await getStockView(app, sku))?.reserved).toBe(2);
    });

    it('refuses a shortfall and leaves neither header nor hold', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 1);

      expect(await tryReserve(order, sku)).toBe('OUT_OF_STOCK');

      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect(await reservationsFor(app, order)).toHaveLength(0);
      expect((await getStockView(app, sku))?.reserved).toBe(0);
    });

    it('commits once: on-hand drops a single time however often commit is repeated', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku);

      expect(await participant.commit(order)).toBe('APPLIED');
      expect(await participant.commit(order)).toBe('IDEMPOTENT');

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 3, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('COMMITTED');
    });

    it('releases a HELD order back to baseline, idempotently', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku);

      expect(await participant.release(order)).toBe('APPLIED');
      expect(await participant.release(order)).toBe('IDEMPOTENT');

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 5, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('RELEASED');
    });

    it('fences an order released before any Try, and refuses the Try that arrives late', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);

      expect(await participant.release(order)).toBe('APPLIED');
      expect((await readReservationOrder(app, order))?.status).toBe('FENCED');
      expect(await tryReserve(order, sku)).toBe('CONFLICT');

      expect((await getStockView(app, sku))?.reserved).toBe(0);
      expect(await reservationsFor(app, order)).toHaveLength(0);
    });

    it('refuses to commit a released order or release a committed one', async () => {
      const [released, committed, sku] = [testId(), testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(released, sku);
      await tryReserve(committed, sku);
      await participant.release(released);
      await participant.commit(committed);

      expect(await participant.commit(released)).toBe('CONFLICT');
      expect(await participant.release(committed)).toBe('CONFLICT');
      expect(await getStockView(app, sku)).toMatchObject({ onHand: 3, reserved: 0 });
    });

    it('restocks a committed order back to the seeded on-hand, and only a committed one', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku);

      expect(await participant.restock(order)).toBe('CONFLICT');
      await participant.commit(order);
      expect(await participant.restock(order)).toBe('APPLIED');
      expect(await participant.restock(order)).toBe('IDEMPOTENT');

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 5, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('RESTOCKED');
      expect((await reservationsFor(app, order)).map((line) => line.status)).toEqual(['RESTOCKED']);
    });

    it('gives up on a stock row locked past the budget, leaving no header and no leaked connection', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      const baseline = checkedOutConnections(pool);
      const unlock = await holdRowLock(pool, LOCK_STOCK_ROW, [sku]);

      const started = Date.now();
      try {
        await expect(tryReserve(order, sku)).rejects.toBeInstanceOf(ReservationTimeoutError);
      } finally {
        await unlock();
      }

      expect(Date.now() - started).toBeLessThan(2 * BUDGET_MS);
      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect(checkedOutConnections(pool)).toBe(baseline);
    });

    // Each wait alone is within the budget; only a deadline for the whole Try catches their sum.
    it('spends one budget across every lock wait, not one per statement', async () => {
      const order = testId();
      const [first, second] = [testId(), testId()].sort((x, y) => x.localeCompare(y));
      await seedStock(app, first, 5);
      await seedStock(app, second, 5);
      const unlockFirst = await holdRowLock(pool, LOCK_STOCK_ROW, [first]);
      const unlockSecond = await holdRowLock(pool, LOCK_STOCK_ROW, [second]);
      const releases = (async () => {
        await sleep(0.7 * BUDGET_MS);
        await unlockFirst();
        await sleep(0.7 * BUDGET_MS);
        await unlockSecond();
      })();

      const started = Date.now();
      const attempt = participant.tryReserve({
        orderId: order,
        lines: [
          { variantId: first, quantity: 1 },
          { variantId: second, quantity: 1 },
        ],
        holdUntil: HOLD_UNTIL,
      });
      await expect(attempt).rejects.toBeInstanceOf(ReservationTimeoutError);
      const elapsed = Date.now() - started;
      await releases;

      expect(elapsed).toBeLessThan(2 * BUDGET_MS);
      expect(await readReservationOrder(app, order)).toBeUndefined();
    });

    it('throws a release stuck behind a locked header and leaves the header HELD', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku);
      const unlock = await holdRowLock(pool, LOCK_HEADER, [order]);

      try {
        await expect(participant.release(order)).rejects.toBeInstanceOf(ReservationTimeoutError);
      } finally {
        await unlock();
      }

      expect((await readReservationOrder(app, order))?.status).toBe('HELD');
      expect((await getStockView(app, sku))?.reserved).toBe(2);
    });
  });
});
