import type { Logger as DrizzleQueryLogger } from 'drizzle-orm';
import type { ClsService } from 'nestjs-cls';

const DB_QUERIES_KEY = 'dbQueries';

// Deliberately a no-op outside a request (seed/migration scripts, startup): there is no CLS
// context to attribute the query to.
export function incrementDbQueryCount(cls: ClsService): void {
  if (!cls.isActive()) return;
  const current = cls.get<number>(DB_QUERIES_KEY) ?? 0;
  cls.set(DB_QUERIES_KEY, current + 1);
}

export function getDbQueryCount(cls: ClsService): number {
  return cls.isActive() ? (cls.get<number>(DB_QUERIES_KEY) ?? 0) : 0;
}

/**
 * A Drizzle logger that emits nothing: it only tallies into CLS, so the canonical log line can
 * report `db.queries` (an N+1 signal) without touching repositories.
 */
export function createDbQueryCounterLogger(cls: ClsService): DrizzleQueryLogger {
  return {
    logQuery: (): void => incrementDbQueryCount(cls),
  };
}
