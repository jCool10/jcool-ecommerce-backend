import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { DRIZZLE, type DrizzleDB } from '../../../src/database';
import * as schema from '../../../src/database/schema';
import { testId } from '../id-service-stub';
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
    .values({ id: testId(), variantId, quantityOnHand: onHand, quantityReserved: reserved })
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

export async function readStock(app: INestApplication, variantId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
  return row;
}

export async function reservationsFor(app: INestApplication, orderId: string, variantId?: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const byOrder = eq(schema.reservations.orderId, orderId);
  return db
    .select()
    .from(schema.reservations)
    .where(variantId === undefined ? byOrder : and(byOrder, eq(schema.reservations.variantId, variantId)));
}

/**
 * Blocks until at least one backend is parked on a row lock, so a race test can commit the holder
 * only once the contender has provably arrived, rather than after a sleep that is a guess.
 *
 * `datname = current_database()` is load-bearing under file parallelism: `pg_stat_activity` is
 * server-wide, so without it a worker sees a *different* worker's blocked backend, returns early,
 * and the race under test never happens, so the test passes for the wrong reason.
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
 * Waits for the contender to park on the lock, then releases the holder whether or not the wait
 * succeeded: every caller sits on an open transaction, and an un-released holder would wedge the next
 * TRUNCATE until the hook timeout.
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

/** The order's participant header, or undefined when no command ever reached it. */
export async function readReservationOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.reservationOrders).where(eq(schema.reservationOrders.orderId, orderId));
  return row;
}

/** Moves the header's `hold_until` into the past, the one thing a sweep test cannot wait for. */
export async function lapseHoldHeader(app: INestApplication, orderId: string, minutesAgo = 30): Promise<void> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db
    .update(schema.reservationOrders)
    .set({ holdUntil: new Date(Date.now() - minutesAgo * 60_000) })
    .where(eq(schema.reservationOrders.orderId, orderId));
}

/**
 * Runs `lockSql` (a `SELECT ... FOR UPDATE`) in a transaction of its own and keeps it open, so a test
 * can make a command wait on that lock for as long as it likes. The returned function rolls back.
 */
export async function holdRowLock(pool: Pool, lockSql: string, params: unknown[]): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(lockSql, params);
  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
}

/** Clients handed out and not yet returned; a command that leaks one leaves this above its baseline. */
export function checkedOutConnections(pool: Pool): number {
  return pool.totalCount - pool.idleCount;
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
