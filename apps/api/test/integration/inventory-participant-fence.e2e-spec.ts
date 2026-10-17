import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { ReservationTimeoutError } from '../../src/modules/product/domain/stock/errors/reservation-timeout.error';
import { readReservationOrder, releaseOnceBlocked, seedStock } from '../setup/fixtures/inventory.fixture';
import { readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const BUDGET_MS = 1_000;
const FUZZ_ROUNDS = 20;

const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount;

describe.each(['pessimistic', 'optimistic'] as const)('Inventory participant fence, %s (integration)', (strategy) => {
  let app: INestApplication;
  let pool: Pool;
  let participant: InventoryParticipant;
  let repo: StockRepositoryPort;
  let sku: string;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({
      INVENTORY_LOCK_STRATEGY: strategy,
      INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
    }));
    participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = testId();
    await seedStock(app, sku, 10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tryReserve = (orderId: string, quantity = 3) =>
    participant.tryReserve({
      orderId,
      lines: [{ variantId: sku, quantity }],
      holdUntil: new Date(Date.now() + 60 * 60_000),
    });

  // The participant opens its own transaction, so the only way to stop a Try with its header
  // inserted but not committed is to hold it inside the repository call.
  function parkTryAfterHeaderInsert(): { parked: Promise<void>; resume: () => void } {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    let markParked!: () => void;
    const parked = new Promise<void>((resolve) => (markParked = resolve));
    const insertHeader = repo.insertHeader.bind(repo);
    vi.spyOn(repo, 'insertHeader').mockImplementation(async (tx, header) => {
      const inserted = await insertHeader(tx, header);
      if (header.status === 'HELD') {
        markParked();
        await gate;
      }
      return inserted;
    });
    return { parked, resume };
  }

  it('a release queued behind an in-flight Try releases what that Try held', async () => {
    const orderId = testId();
    const { parked, resume } = parkTryAfterHeaderInsert();
    const attempt = tryReserve(orderId);
    await parked;

    const release = participant.release(orderId);
    await releaseOnceBlocked(pool, resume, { subject: 'the release' });

    await expect(attempt).resolves.toEqual({ outcome: 'HELD' });
    await expect(release).resolves.toEqual({ outcome: 'RELEASED' });
    expect((await readStock(app, sku)).quantityReserved).toBe(0);
    expect(await readReservationOrder(app, orderId)).toMatchObject({ status: 'RELEASED' });
  });

  it('a Try that arrives after the release fenced its order is refused', async () => {
    const orderId = testId();
    await participant.release(orderId);

    await expect(tryReserve(orderId)).resolves.toEqual({ outcome: 'CONFLICT' });

    expect((await readStock(app, sku)).quantityReserved).toBe(0);
  });

  it('never leaves an order HELD when its Try and release race', async () => {
    const outcomes = [];
    for (let round = 0; round < FUZZ_ROUNDS; round++) {
      const orderId = testId();
      const [tried, released] = await Promise.all([tryReserve(orderId), participant.release(orderId)]);
      const header = await readReservationOrder(app, orderId);
      outcomes.push({ tried: tried.outcome, released: released.outcome, header: header?.status });
    }

    for (const outcome of outcomes) {
      expect([
        { tried: 'HELD', released: 'RELEASED', header: 'RELEASED' },
        { tried: 'CONFLICT', released: 'FENCED', header: 'FENCED' },
      ]).toContainEqual(outcome);
    }
    expect((await readStock(app, sku)).quantityReserved).toBe(0);
  });

  it('two Trys of one order hold its stock once', async () => {
    const orderId = testId();
    const { parked, resume } = parkTryAfterHeaderInsert();
    const first = tryReserve(orderId);
    await parked;

    const second = tryReserve(orderId);
    await releaseOnceBlocked(pool, resume, { subject: 'the second Try' });

    expect(await Promise.all([first, second])).toEqual([{ outcome: 'HELD' }, { outcome: 'HELD' }]);
    expect((await readStock(app, sku)).quantityReserved).toBe(3);
    expect(await reservationsFor(app, orderId)).toHaveLength(1);
  });

  it('sells the last unit to exactly one of many concurrent Trys', async () => {
    await seedStock(app, sku, 1);

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => tryReserve(testId(), 1)));

    expect(outcomes.filter(({ outcome }) => outcome === 'HELD')).toHaveLength(1);
    expect(outcomes.filter(({ outcome }) => outcome === 'OUT_OF_STOCK')).toHaveLength(7);
    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 1, quantityReserved: 1 });
  });

  // FENCED here would let the parked Try commit a hold nobody releases.
  it('a release stuck behind a parked Try times out instead of fencing, and frees its connection', async () => {
    const orderId = testId();
    const { parked, resume } = parkTryAfterHeaderInsert();
    const attempt = tryReserve(orderId);
    await parked;

    const startedAt = Date.now();
    const release = await participant.release(orderId).catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;
    resume();
    await attempt;

    expect(release).toBeInstanceOf(ReservationTimeoutError);
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 500);
    expect(checkedOut(pool)).toBe(0);
  });
});
