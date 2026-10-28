import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ReservationCommand,
  type ReservationLineBody,
  isLockBudgetExhausted,
  reservationRoutes,
} from '@jcool/internal-contracts';
import {
  checkedOutConnections,
  getStockView,
  holdRowLock,
  readReservationOrder,
  reservationsFor,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { closeAppAfterAll, createTestAppWithPool, internalPost, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { metricsAuthHeader } from '../setup/metrics.helper';
import { sleep } from '../setup/sleep';

const BUDGET_MS = 600;
const HOLD_UNTIL = new Date(Date.now() + 2 * 60 * 60_000);
const LOCK_STOCK_ROW = 'SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE';
const LOCK_HEADER = 'SELECT 1 FROM reservation_orders WHERE order_id = $1 FOR UPDATE';

describe('Inventory participant over the internal API (integration, real Postgres)', () => {
  const api = (getApp: () => INestApplication) => ({
    tryReserve: (orderId: string, lines: ReservationLineBody[]) =>
      internalPost(getApp(), reservationRoutes.try(orderId)).send({ lines, holdUntil: HOLD_UNTIL.toISOString() }),
    command: (orderId: string, command: ReservationCommand) =>
      internalPost(getApp(), reservationRoutes.command(orderId, command)),
    statusOf: (orderIds: string[]) => internalPost(getApp(), reservationRoutes.status).send({ orderIds }),
  });

  // First, while no other app in this file has closed: a closed app's gauge collectors stay in the
  // shared registry and log a scrape failure on every /metrics.
  describe('status and metrics', () => {
    let app: INestApplication;
    let pool: Pool;
    const { tryReserve, command, statusOf } = api(() => app);

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool());
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    const holdOne = (orderId: string, variantId: string) =>
      tryReserve(orderId, [{ variantId, quantity: 1 }]).expect(201);

    it('reports each header, and null for an order that never had one', async () => {
      const [held, committed, fenced, none, sku] = [testId(), testId(), testId(), testId(), testId()];
      await seedStock(app, sku, 5);
      await holdOne(held, sku);
      await holdOne(committed, sku);
      await command(committed, 'commit').expect(200);
      await command(fenced, 'release').expect(200);

      const { body } = await statusOf([held, committed, fenced, none]).expect(200);

      expect(body).toEqual({
        statuses: { [held]: 'HELD', [committed]: 'COMMITTED', [fenced]: 'FENCED', [none]: null },
      });
    });

    it('answers a full batch, one key per id asked for', async () => {
      const fenced = testId();
      await command(fenced, 'release').expect(200);
      const ids = [fenced, ...Array.from({ length: 199 }, () => testId())];

      const { body } = await statusOf(ids).expect(200);
      const statuses = body.statuses as Record<string, string | null>;

      expect(Object.keys(statuses)).toHaveLength(200);
      expect(statuses[fenced]).toBe('FENCED');
      expect(Object.values(statuses).filter((status) => status === null)).toHaveLength(199);
    });

    it('refuses an empty batch and one past 200 ids', async () => {
      await statusOf([]).expect(400);
      await statusOf(Array.from({ length: 201 }, () => testId())).expect(400);
    });

    it('reads past a header another transaction holds locked', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await holdOne(order, sku);
      const unlock = await holdRowLock(pool, LOCK_HEADER, [order]);

      try {
        const started = Date.now();
        const { body } = await statusOf([order]).expect(200);
        expect(body.statuses[order]).toBe('HELD');
        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      } finally {
        await unlock();
      }
    });

    it('counts commands on /metrics by participant, op and outcome', async () => {
      await command(testId(), 'release').expect(200);

      const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

      expect(res.text).toMatch(/tcc_branch_total\{participant="inventory",op="release",outcome="applied"\} [1-9]/);
    });
  });

  describe.each(['pessimistic', 'optimistic'] as const)('%s strategy', (strategy) => {
    let app: INestApplication;
    let pool: Pool;
    const { tryReserve: tryLines, command } = api(() => app);

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({
        INVENTORY_LOCK_STRATEGY: strategy,
        INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
      }));
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    const tryReserve = (orderId: string, variantId: string, quantity = 2) =>
      tryLines(orderId, [{ variantId, quantity }]);

    it('reserves, writes a HELD header and stamps every line with the hold deadline', async () => {
      const [order, a, b] = [testId(), testId(), testId()];
      await seedStock(app, a, 5);
      await seedStock(app, b, 5);

      const { body } = await tryLines(order, [
        { variantId: a, quantity: 2 },
        { variantId: b, quantity: 1 },
      ]).expect(201);

      expect(body).toEqual({ outcome: 'RESERVED' });
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

      await tryReserve(order, sku).expect(201, { outcome: 'RESERVED' });
      await tryReserve(order, sku).expect(201, { outcome: 'RESERVED' });

      expect((await getStockView(app, sku))?.reserved).toBe(2);
    });

    it('refuses a shortfall with a 409 that names no quantity, leaving neither header nor hold', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 1);

      await tryReserve(order, sku).expect(409, { outcome: 'OUT_OF_STOCK' });

      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect(await reservationsFor(app, order)).toHaveLength(0);
      expect((await getStockView(app, sku))?.reserved).toBe(0);
    });

    it('commits once: on-hand drops a single time however often commit is repeated', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku).expect(201);

      await command(order, 'commit').expect(200, { outcome: 'APPLIED' });
      await command(order, 'commit').expect(200, { outcome: 'IDEMPOTENT' });

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 3, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('COMMITTED');
    });

    it('releases a HELD order back to baseline, idempotently', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku).expect(201);

      await command(order, 'release').expect(200, { outcome: 'APPLIED' });
      await command(order, 'release').expect(200, { outcome: 'IDEMPOTENT' });

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 5, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('RELEASED');
    });

    it('fences an order released before any Try, and refuses the Try that arrives late', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);

      await command(order, 'release').expect(200, { outcome: 'APPLIED' });
      expect((await readReservationOrder(app, order))?.status).toBe('FENCED');
      await tryReserve(order, sku).expect(409, { outcome: 'CONFLICT' });

      expect((await getStockView(app, sku))?.reserved).toBe(0);
      expect(await reservationsFor(app, order)).toHaveLength(0);
    });

    it('refuses to commit a released order or release a committed one', async () => {
      const [released, committed, sku] = [testId(), testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(released, sku).expect(201);
      await tryReserve(committed, sku).expect(201);
      await command(released, 'release').expect(200);
      await command(committed, 'commit').expect(200);

      await command(released, 'commit').expect(409, { outcome: 'CONFLICT' });
      await command(committed, 'release').expect(409, { outcome: 'CONFLICT' });
      expect(await getStockView(app, sku)).toMatchObject({ onHand: 3, reserved: 0 });
    });

    it('restocks a committed order back to the seeded on-hand, and only a committed one', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku).expect(201);

      await command(order, 'restock').expect(409, { outcome: 'CONFLICT' });
      await command(order, 'commit').expect(200);
      await command(order, 'restock').expect(200, { outcome: 'APPLIED' });
      await command(order, 'restock').expect(200, { outcome: 'IDEMPOTENT' });

      expect(await getStockView(app, sku)).toMatchObject({ onHand: 5, reserved: 0 });
      expect((await readReservationOrder(app, order))?.status).toBe('RESTOCKED');
      expect((await reservationsFor(app, order)).map((line) => line.status)).toEqual(['RESTOCKED']);
    });

    it('answers a busy-rows 503 with Retry-After for a stock row locked past the budget, leaving no header and no leaked connection', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      const baseline = checkedOutConnections(pool);
      const unlock = await holdRowLock(pool, LOCK_STOCK_ROW, [sku]);

      const started = Date.now();
      let answer: request.Response;
      try {
        answer = await tryReserve(order, sku);
      } finally {
        await unlock();
      }

      expect(isLockBudgetExhausted(answer.status, answer.body)).toBe(true);
      expect(answer.headers['retry-after']).toBe('1');
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
      const answer = await tryLines(order, [
        { variantId: first, quantity: 1 },
        { variantId: second, quantity: 1 },
      ]);
      const elapsed = Date.now() - started;
      await releases;

      expect(isLockBudgetExhausted(answer.status, answer.body)).toBe(true);
      expect(elapsed).toBeLessThan(2 * BUDGET_MS);
      expect(await readReservationOrder(app, order)).toBeUndefined();
    });

    it('answers a busy-rows 503 to a release stuck behind a locked header and leaves the header HELD', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(app, sku, 5);
      await tryReserve(order, sku).expect(201);
      const unlock = await holdRowLock(pool, LOCK_HEADER, [order]);

      let answer: request.Response;
      try {
        answer = await command(order, 'release');
      } finally {
        await unlock();
      }

      expect(isLockBudgetExhausted(answer.status, answer.body)).toBe(true);
      expect((await readReservationOrder(app, order))?.status).toBe('HELD');
      expect((await getStockView(app, sku))?.reserved).toBe(2);
    });
  });
});
