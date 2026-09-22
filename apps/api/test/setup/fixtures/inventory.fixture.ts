import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';
import { sleep } from '../sleep';

const LOCK_POLL_MS = 20;
const LOCK_WAIT_TIMEOUT_MS = 5_000;

export interface SeededStock {
  variantId: string;
  onHand: number;
  reserved: number;
}

export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

export async function seedStock(
  app: INestApplication,
  variantId: string,
  onHand: number,
  reserved = 0,
): Promise<SeededStock> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db
    .insert(schema.stockLevels)
    .values({ variantId, quantityOnHand: onHand, quantityReserved: reserved })
    .onConflictDoUpdate({
      target: schema.stockLevels.variantId,
      set: { quantityOnHand: onHand, quantityReserved: reserved },
    });
  return { variantId, onHand, reserved };
}

/** `available` is the invariant a race must keep >= 0. */
export async function getStockView(app: INestApplication, variantId: string): Promise<StockView | null> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db
    .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.variantId, variantId));
  if (!row) return null;
  return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}

/**
 * Blocks until at least one backend is parked on a row lock, so a race test can commit the holder
 * only once the contender has provably arrived — rather than after a sleep that is a guess.
 *
 * `datname = current_database()` is load-bearing under file parallelism: `pg_stat_activity` is
 * server-wide, so without it a worker sees a *different* worker's blocked backend, returns early,
 * and the race under test never happens — the test then passes for the wrong reason.
 */
export async function waitUntilBlockedOnLock(
  pool: Pool,
  { timeoutMs = LOCK_WAIT_TIMEOUT_MS, subject = 'the contender' }: { timeoutMs?: number; subject?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0].n) >= 1) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${subject} to block on the row lock`);
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Waits for the contender to park on the lock, then releases the holder **whether or not the wait
 * succeeded**.
 *
 * The release has to be in a `finally`, because every caller is sitting on an open transaction while
 * it waits. Letting the timeout propagate past an un-released holder turns a 5s diagnostic into a
 * two-minute wedge: the holder keeps its row lock and its pooled connection, the next
 * `resetDatabaseBeforeEach` blocks on `TRUNCATE ... CASCADE` until `hookTimeout`, and every
 * remaining test in the file fails with a cause that points nowhere near the real one.
 */
export async function releaseOnceBlocked(
  pool: Pool,
  releaseHolder: () => void,
  options: { timeoutMs?: number; subject?: string } = {},
): Promise<void> {
  try {
    await waitUntilBlockedOnLock(pool, options);
  } finally {
    releaseHolder();
  }
}

/** Must equal the number of winning holds after a race. */
export async function countHeldReservations(app: INestApplication, variantId: string): Promise<number> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const rows = await db
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.variantId, variantId), eq(schema.reservations.status, 'HELD')));
  return rows.length;
}
