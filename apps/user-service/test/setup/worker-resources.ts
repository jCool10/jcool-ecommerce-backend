import { inject } from 'vitest';
import { workerCount } from './worker-count';

// Files run in parallel; each worker owns a database cloned from the migrated template and a Redis
// logical db, both keyed by VITEST_POOL_ID, so a TRUNCATE or a throttle counter never crosses files.

export const TEMPLATE_DATABASE = 'e2e_template';

/** Redis ships 16 logical databases; 0 is left to anything outside the suite. */
export const MAX_REDIS_DB_INDEX = 15;

export { workerCount };

export function currentWorkerId(): number {
  const parsed = Number(process.env.VITEST_POOL_ID ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function workerDatabaseName(workerId: number): string {
  return `e2e_w${workerId}`;
}

export function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function assertWorkerBudget(): void {
  const workerId = currentWorkerId();
  if (workerId > workerCount()) {
    throw new Error(
      `E2E worker ${workerId} has no pre-created database: globalSetup created ${workerCount()} (E2E_WORKERS).`,
    );
  }
  if (workerId > MAX_REDIS_DB_INDEX) {
    throw new Error(`E2E worker ${workerId} exceeds Redis's ${MAX_REDIS_DB_INDEX + 1} logical databases.`);
  }
}

export function workerDatabaseUrl(): string {
  assertWorkerBudget();
  return withDatabase(inject('PG_BASE_URL'), workerDatabaseName(currentWorkerId()));
}

export function workerRedisUrl(): string {
  assertWorkerBudget();
  const url = new URL(inject('REDIS_BASE_URL'));
  url.pathname = `/${currentWorkerId()}`;
  return url.toString();
}

// A setupFile: a budget mismatch fails the worker once, not whichever test connects first.
assertWorkerBudget();
