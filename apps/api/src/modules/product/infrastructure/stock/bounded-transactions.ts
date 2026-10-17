import { sql } from 'drizzle-orm';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';

// lock_not_available and query_canceled: what lock_timeout and statement_timeout raise.
const TIMEOUT_SQLSTATES = new Set(['55P03', '57014']);

interface Deadline {
  at: number;
  timeoutMs: number;
}

/**
 * Transactions with a wall-clock limit. Postgres times every lock wait and every statement on its
 * own and PG16 has no `transaction_timeout`, so the limit is re-armed with whatever time is left
 * before each statement that may block.
 */
export class BoundedTransactions {
  // Keyed by tx, so a transaction the caller opened itself (the checkout path) stays unbounded.
  private readonly deadlines = new WeakMap<DrizzleTx, Deadline>();

  constructor(private readonly db: DrizzleDB) {}

  async run<T>(work: (tx: DrizzleTx) => Promise<T>, timeoutMs?: number): Promise<T> {
    if (timeoutMs === undefined) {
      return this.db.transaction(work);
    }
    // Taken before the pool hands out a connection, so a slow checkout spends the limit too.
    const deadline = { at: Date.now() + timeoutMs, timeoutMs };
    try {
      return await this.db.transaction(async (tx) => {
        this.deadlines.set(tx, deadline);
        let result: T;
        try {
          result = await work(tx);
        } catch (error) {
          // ROLLBACK would inherit a timeout cut to the last few ms, and a cancelled ROLLBACK returns
          // the connection to the pool inside the aborted transaction. An aborted tx refuses the SET.
          await liftStatementTimeout(tx).catch(() => undefined);
          throw error;
        }
        // Not swallowed: a cancelled SET aborts the transaction, and COMMIT would then roll back silently.
        await liftStatementTimeout(tx);
        return result;
      });
    } catch (error) {
      throw hasSqlState(error, TIMEOUT_SQLSTATES) ? new ReservationTimeoutError(timeoutMs) : error;
    }
  }

  /** Call right before a statement that may wait on a lock. A no-op outside `run` with a limit. */
  async arm(tx: DrizzleTx): Promise<void> {
    const deadline = this.deadlines.get(tx);
    if (!deadline) {
      return;
    }
    const remainingMs = deadline.at - Date.now();
    if (remainingMs <= 0) {
      throw new ReservationTimeoutError(deadline.timeoutMs);
    }
    const limit = `${remainingMs}ms`;
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${limit}, true), set_config('statement_timeout', ${limit}, true)`,
    );
  }
}

async function liftStatementTimeout(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
}

// Drizzle wraps the driver error, so the SQLSTATE sits somewhere down the `cause` chain.
function hasSqlState(error: unknown, codes: ReadonlySet<string>): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== 'object') {
      return false;
    }
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && codes.has(code)) {
      return true;
    }
    current = cause;
  }
  return false;
}
