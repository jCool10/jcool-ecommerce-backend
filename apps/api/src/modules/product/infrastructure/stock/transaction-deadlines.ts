import { sql } from 'drizzle-orm';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';

// lock_not_available (lock_timeout) and query_canceled (statement_timeout).
const DEADLINE_SQLSTATES = new Set(['55P03', '57014']);

interface Deadline {
  at: number;
  armed: boolean;
}

/**
 * PG16 has no transaction_timeout, and lock_timeout/statement_timeout restart on every wait and every
 * statement, so a budget for the whole transaction has to be a wall-clock deadline: each statement that
 * can wait on a lock is limited to what is left of it. Keyed by the tx object, so a transaction opened
 * without a deadline never pays for an extra statement.
 */
export class TransactionDeadlines {
  private readonly byTx = new WeakMap<DrizzleTx, Deadline>();

  async run<T>(db: DrizzleDB, at: number, work: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        const deadline: Deadline = { at, armed: false };
        this.byTx.set(tx, deadline);
        try {
          return await work(tx);
        } catch (error) {
          // After a DB error only ROLLBACK runs. After an application error the tx is still healthy, and
          // a statement_timeout of a few ms left in place could cancel the ROLLBACK itself.
          if (deadline.armed && sqlStateOf(error) === undefined) {
            await tx.execute(sql`SELECT set_config('statement_timeout', '0', true)`).catch(() => undefined);
          }
          throw error;
        }
      });
    } catch (error) {
      throw DEADLINE_SQLSTATES.has(sqlStateOf(error) ?? '') ? new ReservationTimeoutError() : error;
    }
  }

  /** Call right before a statement that can wait on a lock. */
  async limit(tx: DrizzleTx): Promise<void> {
    const deadline = this.byTx.get(tx);
    if (!deadline) return;

    const remainingMs = deadline.at - Date.now();
    if (remainingMs <= 0) throw new ReservationTimeoutError();

    deadline.armed = true;
    const ms = String(remainingMs);
    await tx.execute(sql`SELECT set_config('lock_timeout', ${ms}, true), set_config('statement_timeout', ${ms}, true)`);
  }
}

// Drizzle wraps the driver error, so the SQLSTATE sits somewhere down the cause chain.
function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = cause;
  }
  return undefined;
}
