import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';
import { POOL_RULE_DEFAULTS } from './env.validation';

// Clears the given keys before each test and puts them back after, so config keys never leak
// into sibling specs sharing the process.
function isolateEnv(keys: readonly string[]): void {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('configuration', () => {
  isolateEnv(['ID_SERVICE_URL', 'ID_SERVICE_TIMEOUT_MS', ...Object.keys(POOL_RULE_DEFAULTS)]);

  it('reads the id-service address and gives the call the gateway retries 2s by default', () => {
    process.env.ID_SERVICE_URL = 'http://gateway:4000';

    expect(configuration().idService).toEqual({ url: 'http://gateway:4000', timeoutMs: 2_000 });
  });

  it("sizes the api pool at the platform's 10 by default, and lets DB_POOL_MAX win", () => {
    expect(configuration().database.poolMax).toBe(10);

    process.env.DB_POOL_MAX = '7';
    expect(configuration().database.poolMax).toBe(7);
  });

  // The pool rule resolves an unset var to these; drifting from what loads would validate one
  // config and run another.
  it('mirrors the defaults the pool rule resolves to', () => {
    const config = configuration();

    expect({
      QUEUE_WORKER_CONCURRENCY: config.queue.workerConcurrency,
      DB_POOL_MAX: config.database.poolMax,
    }).toEqual(POOL_RULE_DEFAULTS);
  });
});
