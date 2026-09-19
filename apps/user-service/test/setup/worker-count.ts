// No vitest import: the config reads this before any worker exists.

const DEFAULT_WORKERS = 4;

/** Throws on a malformed E2E_WORKERS: Vitest reads `maxWorkers: NaN` as one worker per CPU. */
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
