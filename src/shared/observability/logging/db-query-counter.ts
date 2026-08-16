import type { Logger as DrizzleQueryLogger } from 'drizzle-orm';
import type { ClsService } from 'nestjs-cls';

/** CLS key for the per-request DB query tally surfaced on the canonical log line. */
const DB_QUERIES_KEY = 'dbQueries';

// Bump the per-request DB query tally. No-op outside a request (seed/migration scripts,
// startup) where there is no CLS context to attribute the query to.
export function incrementDbQueryCount(cls: ClsService): void {
  if (!cls.isActive()) return;
  const current = cls.get<number>(DB_QUERIES_KEY) ?? 0;
  cls.set(DB_QUERIES_KEY, current + 1);
}

/** DB queries executed so far in the active request (0 when unattributed). */
export function getDbQueryCount(cls: ClsService): number {
  return cls.isActive() ? (cls.get<number>(DB_QUERIES_KEY) ?? 0) : 0;
}

/**
 * A Drizzle logger that only tallies queries per request into CLS (emits nothing), so the
 * canonical log line can report `db.queries` (an N+1 signal) without touching repositories.
 */
export function createDbQueryCounterLogger(cls: ClsService): DrizzleQueryLogger {
  return {
    logQuery: (): void => incrementDbQueryCount(cls),
  };
}
