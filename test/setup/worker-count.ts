/**
 * How wide the e2e tier runs. Its own module because two very different consumers need the same
 * answer and must not drift: `test/vitest-e2e.config.mts` caps the worker pool with it, and
 * `test/setup/worker-resources.ts` pre-creates exactly that many databases and Redis indices.
 *
 * Kept free of side effects and of any `vitest` import on purpose — the config is loaded before a
 * worker exists, so it cannot import `worker-resources.ts` (that module calls `inject()` and asserts
 * the budget at import time).
 */

const DEFAULT_WORKERS = 4;

/**
 * Rejects a malformed `E2E_WORKERS` instead of coercing it. `Number('abc')` is `NaN`, and Vitest
 * treats `maxWorkers: NaN` as "unset" and silently spawns one worker per CPU — every worker above
 * the pre-created range then dies on a database that was never cloned, pointing at a config drift
 * that does not exist.
 */
export function workerCount(): number {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined || raw === '') {
    return DEFAULT_WORKERS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`E2E_WORKERS must be a positive integer; received ${JSON.stringify(raw)}.`);
  }
  return parsed;
}
