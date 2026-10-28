import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { reservationRoutes } from '@jcool/internal-contracts';
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { closeAppAfterAll, createTestAppWithPool, internalPost, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const CONTENDERS = 20;
const LOSING = new Set(['409 OUT_OF_STOCK', '409 CONTENDED']);

describe.each(['pessimistic', 'optimistic'] as const)('Last unit over the internal API, %s locking', (strategy) => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({ INVENTORY_LOCK_STRATEGY: strategy }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it(`lets exactly one of ${CONTENDERS} concurrent Trys take it`, async () => {
    const variantId = testId();
    await seedStock(app, variantId, 1);
    const holdUntil = new Date(Date.now() + 3_600_000).toISOString();

    const answers = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        internalPost(app, reservationRoutes.try(testId())).send({ lines: [{ variantId, quantity: 1 }], holdUntil }),
      ),
    );

    const outcomes = answers.map(({ status, body }) => `${status} ${(body as { outcome?: string }).outcome}`);
    expect(outcomes.filter((outcome) => outcome === '201 RESERVED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== '201 RESERVED' && !LOSING.has(outcome))).toEqual([]);
    expect(await getStockView(app, variantId)).toEqual({ onHand: 1, reserved: 1, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(1);
  });
});
