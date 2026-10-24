import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { ReservationTimeoutError } from '../../src/modules/product/domain/stock/errors/reservation-timeout.error';
import {
  checkedOutConnections,
  getStockView,
  readReservationOrder,
  releaseOnceBlocked,
  seedStock,
} from '../setup/fixtures/inventory.fixture';
import { reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { sleep } from '../setup/sleep';

const BUDGET_MS = 1_000;
const HOLD_UNTIL = new Date(Date.now() + 2 * 60 * 60_000);
const FUZZ_ROUNDS = 20;
const FUZZ_STAGGER_STEPS = 6;
const CONTENDERS = 8;

function participantApp(strategy: 'pessimistic' | 'optimistic') {
  const ctx = {} as { app: INestApplication; pool: Pool; participant: InventoryParticipant; repo: StockRepositoryPort };
  beforeAll(async () => {
    const { app, pool } = await createTestAppWithPool({
      INVENTORY_LOCK_STRATEGY: strategy,
      INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
    });
    Object.assign(ctx, {
      app,
      pool,
      participant: app.get<InventoryParticipant>(INVENTORY_PARTICIPANT),
      repo: app.get<StockRepositoryPort>(STOCK_REPOSITORY),
    });
  });
  closeAppAfterAll(() => ctx.app);
  resetDatabaseBeforeEach(() => ctx.pool);
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return ctx;
}

/**
 * Parks the next Try inside its own transaction, right after the header insert. The participant opens
 * its tx itself, so a test-held transaction cannot stand in for it.
 */
function pauseAfterHeaderInsert(repo: StockRepositoryPort) {
  const insertHeader = repo.insertHeader.bind(repo);
  let arrive!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  vi.spyOn(repo, 'insertHeader').mockImplementationOnce(async (tx, input) => {
    const inserted = await insertHeader(tx, input);
    arrive();
    await gate;
    return inserted;
  });
  return { arrived, open };
}

describe('Inventory participant fence under concurrency (integration, real Postgres)', () => {
  describe('pessimistic strategy', () => {
    const ctx = participantApp('pessimistic');

    const tryReserve = (orderId: string, variantId: string, quantity = 1) =>
      ctx.participant.tryReserve({ orderId, lines: [{ variantId, quantity }], holdUntil: HOLD_UNTIL });

    it('makes a release wait on an in-flight Try, then releases what it reserved', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(ctx.app, sku, 5);
      const pause = pauseAfterHeaderInsert(ctx.repo);

      const tried = tryReserve(order, sku, 2);
      await pause.arrived;
      const released = ctx.participant.release(order);
      await releaseOnceBlocked(ctx.pool, pause.open, { subject: 'the release' });

      expect(await tried).toBe('RESERVED');
      expect(await released).toBe('APPLIED');
      expect((await readReservationOrder(ctx.app, order))?.status).toBe('RELEASED');
      expect((await getStockView(ctx.app, sku))?.reserved).toBe(0);
    });

    it('refuses a Try that arrives after the release fenced the order', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(ctx.app, sku, 5);

      expect(await ctx.participant.release(order)).toBe('APPLIED');
      expect(await tryReserve(order, sku)).toBe('CONFLICT');
      expect((await getStockView(ctx.app, sku))?.reserved).toBe(0);
    });

    it('never leaves a hold behind, whichever of Try and Release lands first', async () => {
      const sku = testId();
      await seedStock(ctx.app, sku, 5);
      const landed = new Set<string | undefined>();

      for (let round = 0; round < FUZZ_ROUNDS; round++) {
        const order = testId();
        // Try mints its ids before touching the database, so an unstaggered Release almost always fences first.
        const [tried, released] = await Promise.all([
          tryReserve(order, sku),
          sleep(round % FUZZ_STAGGER_STEPS).then(() => ctx.participant.release(order)),
        ]);

        expect(['RESERVED', 'CONFLICT']).toContain(tried);
        expect(released).toBe('APPLIED');
        const status = (await readReservationOrder(ctx.app, order))?.status;
        expect(['RELEASED', 'FENCED']).toContain(status);
        landed.add(status);
        expect((await getStockView(ctx.app, sku))?.reserved).toBe(0);
      }

      expect(landed).toEqual(new Set(['RELEASED', 'FENCED']));
    });

    it('sells the last unit exactly once to concurrent orders', async () => {
      const sku = testId();
      await seedStock(ctx.app, sku, 1);

      const outcomes = await Promise.all(Array.from({ length: CONTENDERS }, () => tryReserve(testId(), sku)));

      expect(outcomes.filter((outcome) => outcome === 'RESERVED')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'OUT_OF_STOCK')).toHaveLength(CONTENDERS - 1);
      const stock = await getStockView(ctx.app, sku);
      expect(stock?.onHand).toBeGreaterThanOrEqual(stock?.reserved ?? Infinity);
    });

    it('times a release out behind a Try parked past the budget, and returns every connection', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(ctx.app, sku, 5);
      const baseline = checkedOutConnections(ctx.pool);
      const pause = pauseAfterHeaderInsert(ctx.repo);

      const tried = tryReserve(order, sku);
      await pause.arrived;
      const started = Date.now();
      try {
        await expect(ctx.participant.release(order)).rejects.toBeInstanceOf(ReservationTimeoutError);
        expect(Date.now() - started).toBeLessThan(2 * BUDGET_MS);
      } finally {
        pause.open();
      }

      // The parked Try outlived its own deadline too, so it gives up before reserving anything.
      await expect(tried).rejects.toBeInstanceOf(ReservationTimeoutError);
      expect(checkedOutConnections(ctx.pool)).toBe(baseline);
      expect(await readReservationOrder(ctx.app, order)).toBeUndefined();
    });
  });

  // The optimistic CAS takes no lock up front; the header is what serializes the same order here.
  describe('optimistic strategy', () => {
    const ctx = participantApp('optimistic');

    it('holds once when the same order tries twice at the same time', async () => {
      const [order, sku] = [testId(), testId()];
      await seedStock(ctx.app, sku, 5);
      const tryReserve = () =>
        ctx.participant.tryReserve({ orderId: order, lines: [{ variantId: sku, quantity: 2 }], holdUntil: HOLD_UNTIL });

      expect(await Promise.all([tryReserve(), tryReserve()])).toEqual(['RESERVED', 'RESERVED']);

      expect(await reservationsFor(ctx.app, order)).toHaveLength(1);
      expect((await getStockView(ctx.app, sku))?.reserved).toBe(2);
    });
  });
});
