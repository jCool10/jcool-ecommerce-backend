import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { ReservationDeadlineError } from '../../src/modules/inventory/domain/errors/reservation-deadline.error';
import { ReservationTimeoutError } from '../../src/modules/inventory/domain/errors/reservation-timeout.error';
import { TransactionDeadlines } from '../../src/modules/inventory/infrastructure/transaction-deadlines';
import { holdRowLock, seedStock } from '../setup/fixtures/inventory.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const BUDGET_MS = 400;

// Which timeout Postgres raises decides which code the caller sees, so it is checked against the real thing.
describe('TransactionDeadlines (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  const deadlines = new TransactionDeadlines();

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
    db = app.get<DrizzleDB>(DRIZZLE);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('reports a wait behind a row lock as contention, never as a slow statement', async () => {
    const variantId = testId();
    await seedStock(app, variantId, 5);
    const release = await holdRowLock(pool, 'SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE', [variantId]);

    try {
      const waited = deadlines.run(db, Date.now() + BUDGET_MS, async (tx) => {
        await deadlines.limit(tx);
        await tx.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId)).for('update');
      });

      await expect(waited).rejects.toBeInstanceOf(ReservationTimeoutError);
    } finally {
      await release();
    }
  });

  it('reports a statement that is slow without any lock as a deadline fault, not contention', async () => {
    const slow = deadlines.run(db, Date.now() + BUDGET_MS, async (tx) => {
      await deadlines.limit(tx);
      await tx.execute(sql`SELECT pg_sleep(3)`);
    });

    await expect(slow).rejects.toBeInstanceOf(ReservationDeadlineError);
  });
});
