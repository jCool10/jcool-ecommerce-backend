import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
  type TryReserveResult,
} from '../../src/modules/product/application/public/inventory-participant.port';
import { InventoryParticipantService } from '../../src/modules/product/application/stock/inventory-participant.service';
import { ReservationTimeoutError } from '../../src/modules/product/domain/stock/errors/reservation-timeout.error';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { ID_GENERATOR, type IdGeneratorPort } from '../../src/shared/identity/id-generator.port';
import { readReservationOrder, releaseOnceBlocked, seedStock } from '../setup/fixtures/inventory.fixture';
import { readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const STOCK = 10;
const QUANTITY = 2;
const FUZZ_ROUNDS = 20;
const CONTENDERS = 10;
const TRY_BUDGET_MS = 1000;

// Parks every Try right after its header insert, transaction still open, until the test resumes it.
function participantPausedAfterHeaderInsert(app: INestApplication) {
  const real = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => (reached = resolve));
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => (resume = resolve));

  const pausing: StockRepositoryPort = Object.assign(Object.create(real) as StockRepositoryPort, {
    insertHeader: async (...args: Parameters<StockRepositoryPort['insertHeader']>) => {
      const inserted = await real.insertHeader(...args);
      reached();
      await resumed;
      return inserted;
    },
  });
  const participant = new InventoryParticipantService(
    pausing,
    app.get<IdGeneratorPort>(ID_GENERATOR),
    app.get(ConfigService),
    app.get<MetricsPort>(METRICS),
  );
  return { participant, paused, resume };
}

describe('Inventory participant under concurrency (integration, real Postgres)', () => {
  describe('pessimistic', () => {
    let app: INestApplication;
    let pool: Pool;
    let participant: InventoryParticipant;
    let sku: string;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({
        INVENTORY_LOCK_STRATEGY: 'pessimistic',
        INVENTORY_TRY_LOCK_TIMEOUT_MS: String(TRY_BUDGET_MS),
      }));
      participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    beforeEach(async () => {
      sku = testId();
      await seedStock(app, sku, STOCK);
    });

    const tryWith = (p: InventoryParticipant, orderId: string, quantity = QUANTITY) =>
      p.tryReserve({ orderId, lines: [{ variantId: sku, quantity }], holdUntil: new Date(Date.now() + 3_600_000) });

    it('queues a release behind a Try whose header is not committed yet, then releases what it held', async () => {
      const order = testId();
      const { participant: pausedParticipant, paused, resume } = participantPausedAfterHeaderInsert(app);

      const tried = tryWith(pausedParticipant, order);
      await paused;
      const released = participant.release(order);
      await releaseOnceBlocked(pool, resume, { subject: 'the release' });

      expect(await tried).toEqual({ outcome: 'HELD' });
      expect(await released).toEqual({ outcome: 'RELEASED' });
      expect((await readReservationOrder(app, order)).status).toBe('RELEASED');
      expect((await readStock(app, sku)).quantityReserved).toBe(0);
    });

    it('refuses a Try that arrives after the release fenced its order', async () => {
      const order = testId();

      expect(await participant.release(order)).toEqual({ outcome: 'FENCED' });
      expect(await tryWith(participant, order)).toEqual({ outcome: 'CONFLICT' });

      expect((await readStock(app, sku)).quantityReserved).toBe(0);
      expect(await reservationsFor(app, order)).toHaveLength(0);
    });

    it('never leaves an order HELD when Try and release race', async () => {
      for (let round = 0; round < FUZZ_ROUNDS; round++) {
        const order = testId();
        const [tried, released] = await Promise.all([tryWith(participant, order), participant.release(order)]);
        const { status } = await readReservationOrder(app, order);

        const expected = status === 'RELEASED' ? ['HELD', 'RELEASED'] : ['CONFLICT', 'FENCED'];
        expect([tried.outcome, released.outcome], `round ${round} ended ${status}`).toEqual(expected);
      }

      expect((await readStock(app, sku)).quantityReserved).toBe(0);
    });

    it('lets exactly one of many Trys hold the last unit', async () => {
      await seedStock(app, sku, 1);

      const results = await Promise.all(Array.from({ length: CONTENDERS }, () => tryWith(participant, testId(), 1)));

      expect(countOutcomes(results)).toEqual({ HELD: 1, OUT_OF_STOCK: CONTENDERS - 1 });
      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 1, quantityReserved: 1 });
    });

    it('throws, rather than answering CONTENDED, when a Try times out behind another Try of its order', async () => {
      const order = testId();
      const { participant: pausedParticipant, paused, resume } = participantPausedAfterHeaderInsert(app);

      const first = tryWith(pausedParticipant, order);
      await paused;
      const watchdog = setTimeout(resume, TRY_BUDGET_MS * 3);
      try {
        await expect(tryWith(participant, order)).rejects.toBeInstanceOf(ReservationTimeoutError);
      } finally {
        clearTimeout(watchdog);
        resume();
      }

      // Parked past its own budget, so it rolls back rather than holds.
      expect(await first).toMatchObject({ outcome: 'CONTENDED' });
      expect(await tryWith(participant, order)).toEqual({ outcome: 'HELD' });
      expect((await readStock(app, sku)).quantityReserved).toBe(QUANTITY);
    });

    it('times out a release queued behind a stalled Try instead of fencing, and both hand back their connections', async () => {
      const order = testId();
      const checkedOut = () => pool.totalCount - pool.idleCount;
      const baseline = checkedOut();
      const { participant: pausedParticipant, paused, resume } = participantPausedAfterHeaderInsert(app);

      const tried = tryWith(pausedParticipant, order);
      await paused;
      const watchdog = setTimeout(resume, TRY_BUDGET_MS * 3);
      try {
        const started = Date.now();
        await expect(participant.release(order)).rejects.toBeInstanceOf(ReservationTimeoutError);
        expect(Date.now() - started).toBeLessThan(TRY_BUDGET_MS * 2);
      } finally {
        clearTimeout(watchdog);
        resume();
      }

      expect(await tried).toMatchObject({ outcome: 'CONTENDED' });
      expect(await readReservationOrder(app, order)).toBeUndefined();
      expect((await readStock(app, sku)).quantityReserved).toBe(0);
      expect(checkedOut()).toBe(baseline);
    });

    it('settles orders whose lines cross without deadlocking', async () => {
      const other = testId();
      await seedStock(app, other, STOCK);
      const holdUntil = new Date(Date.now() + 3_600_000);
      const tryLines = (orderId: string, variants: string[]) =>
        participant.tryReserve({
          orderId,
          lines: variants.map((variantId) => ({ variantId, quantity: 1 })),
          holdUntil,
        });

      for (let round = 0; round < FUZZ_ROUNDS; round++) {
        const [kept, dropped] = [testId(), testId()];

        const tried = await Promise.all([tryLines(kept, [sku, other]), tryLines(dropped, [other, sku])]);
        const settled = await Promise.all([participant.commit(kept), participant.release(dropped)]);
        const restocked = await participant.restock(kept);

        expect([...tried, ...settled, restocked], `round ${round}`).toEqual([
          { outcome: 'HELD' },
          { outcome: 'HELD' },
          { outcome: 'COMMITTED' },
          { outcome: 'RELEASED' },
          { outcome: 'RESTOCKED' },
        ]);
      }

      for (const variantId of [sku, other]) {
        expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
      }
    });
  });

  describe('optimistic', () => {
    let app: INestApplication;
    let pool: Pool;
    let participant: InventoryParticipant;
    let sku: string;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({ INVENTORY_LOCK_STRATEGY: 'optimistic' }));
      participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    beforeEach(async () => {
      sku = testId();
      await seedStock(app, sku, STOCK);
    });

    const tryWith = (p: InventoryParticipant, orderId: string, quantity = QUANTITY) =>
      p.tryReserve({ orderId, lines: [{ variantId: sku, quantity }], holdUntil: new Date(Date.now() + 3_600_000) });

    it('holds once when a second Try for the order arrives while the first is still open', async () => {
      const order = testId();
      const { participant: pausedParticipant, paused, resume } = participantPausedAfterHeaderInsert(app);

      const first = tryWith(pausedParticipant, order);
      await paused;
      const second = tryWith(participant, order);
      await releaseOnceBlocked(pool, resume, { subject: 'the second Try' });

      expect(await Promise.all([first, second])).toEqual([{ outcome: 'HELD' }, { outcome: 'HELD' }]);
      expect(await readStock(app, sku)).toMatchObject({ quantityReserved: QUANTITY, version: 1 });
      expect(await reservationsFor(app, order)).toHaveLength(1);
    });

    it('lets exactly one of many Trys hold the last unit', async () => {
      await seedStock(app, sku, 1);

      const results = await Promise.all(Array.from({ length: CONTENDERS }, () => tryWith(participant, testId(), 1)));

      expect(countOutcomes(results)).toEqual({ HELD: 1, OUT_OF_STOCK: CONTENDERS - 1 });
      expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 1, quantityReserved: 1 });
    });
  });
});

function countOutcomes(results: TryReserveResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}
