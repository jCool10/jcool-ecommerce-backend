import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 10;

/**
 * Counts backends in this worker's database parked on a lock (row or advisory alike —
 * `pg_stat_activity` reports both under `wait_event_type = 'Lock'`); `pg_stat_activity` is
 * server-wide, hence the `datname` filter.
 */
export async function waitForLockWaiters(pool: Pool, count: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0].n) >= count) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} backends to block on a lock`);
    await sleep(LOCK_POLL_MS);
  }
}
