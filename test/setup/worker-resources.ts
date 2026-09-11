import { inject } from 'vitest';
import { workerCount } from './worker-count';

/**
 * Per-worker isolation of the two resources every e2e spec shares.
 *
 * The e2e tier runs file-parallel. Three things break when 60 files share one Postgres database and
 * one Redis logical db: `TRUNCATE`-all resets rip rows out from under a neighbour's transaction
 * (foreign-key violations and deadlocks), Redis-backed cache/idempotency/denylist/throttle keys
 * collide across files, and `identity_key_pin` — a single row one file deliberately corrupts —
 * refuses the next app's boot.
 *
 * Each worker therefore gets its own database, cloned from a migrated template
 * (`CREATE DATABASE ... TEMPLATE`, ~96ms, done once per worker in globalSetup) and its own Redis
 * logical db index. Both are derived from `VITEST_POOL_ID`, so spec files stay unaware of the
 * scoping — `createTestApp` resolves the URLs for them.
 *
 * Containers stay shared: a per-worker Postgres costs ~1.9s to boot plus ~1.0s to migrate, 30x the
 * template clone, for identical isolation.
 */

/** Migrated once in globalSetup; never connected to afterwards, or `CREATE ... TEMPLATE` is refused. */
export const TEMPLATE_DATABASE = 'e2e_template';

/** Redis ships 16 logical databases (0-15); index 0 is left to anything running outside the suite. */
const MAX_REDIS_DB_INDEX = 15;

/**
 * How many worker databases globalSetup pre-creates, and the cap `vitest-e2e.config.mts` sets on the
 * pool. Re-exported from `worker-count.ts` so both callers resolve the same function — the config
 * cannot import this module (it calls `inject()` and asserts the budget at import).
 */
export { workerCount, MAX_REDIS_DB_INDEX };

/** 1-based, one per Vitest worker process. Absent outside a worker (e.g. globalSetup) → 1. */
export function currentWorkerId(): number {
  const parsed = Number(process.env.VITEST_POOL_ID ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function workerDatabaseName(workerId: number): string {
  return `e2e_w${workerId}`;
}

/** Swaps the database segment of a Postgres URL, keeping credentials, host and query intact. */
export function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Fails the worker's setup rather than the first test that touches Postgres: a pool id above the
 * pre-created range means the config's `maxWorkers` and `E2E_WORKERS` drifted apart, and the
 * resulting "database e2e_wN does not exist" points nowhere useful.
 */
export function assertWorkerBudget(): void {
  const workerId = currentWorkerId();
  if (workerId > workerCount()) {
    throw new Error(
      `E2E worker ${workerId} has no pre-created database: globalSetup created ${workerCount()} ` +
        `(E2E_WORKERS). Raise E2E_WORKERS or lower maxWorkers in test/vitest-e2e.config.mts.`,
    );
  }
  if (workerId > MAX_REDIS_DB_INDEX) {
    throw new Error(
      `E2E worker ${workerId} exceeds Redis's ${MAX_REDIS_DB_INDEX + 1} logical databases. ` +
        `Cap E2E_WORKERS at ${MAX_REDIS_DB_INDEX}; beyond that, workers would share a Redis db and ` +
        `cache/idempotency/throttle keys would collide silently.`,
    );
  }
}

/** The database this worker owns. Cloned from the migrated template before any spec file loads. */
export function workerDatabaseUrl(): string {
  assertWorkerBudget();
  return withDatabase(inject('PG_BASE_URL'), workerDatabaseName(currentWorkerId()));
}

/** This worker's Redis logical db. Composes with the per-spec-file `QUEUE_PREFIX`, it does not replace it. */
export function workerRedisUrl(): string {
  assertWorkerBudget();
  const url = new URL(inject('REDIS_BASE_URL'));
  url.pathname = `/${currentWorkerId()}`;
  return url.toString();
}

// Registered as a `setupFile`, so a budget mismatch is reported once per worker, at setup, instead
// of as a confusing connection error inside whichever test happened to run first.
assertWorkerBudget();
