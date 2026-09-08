import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';

describe('configuration — database pool bounds', () => {
  const POOL_KEYS = ['DB_POOL_MAX', 'DB_POOL_CONNECTION_TIMEOUT_MS', 'DB_POOL_IDLE_TIMEOUT_MS'] as const;
  const saved = new Map<string, string | undefined>();

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    for (const key of POOL_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore so config keys don't leak into sibling specs sharing the process.
    for (const key of POOL_KEYS) restore(key, saved.get(key));
  });

  it('applies bounded defaults when the pool env is unset (finite connection timeout, not pg 0=forever)', () => {
    const { database } = configuration();

    expect(database.poolMax).toBe(10);
    expect(database.connectionTimeoutMs).toBe(5000);
    expect(database.idleTimeoutMs).toBe(10000);
  });

  it('honors env overrides', () => {
    process.env.DB_POOL_MAX = '40';
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = '2000';
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '30000';

    const { database } = configuration();

    expect(database.poolMax).toBe(40);
    expect(database.connectionTimeoutMs).toBe(2000);
    expect(database.idleTimeoutMs).toBe(30000);
  });

  it.each(['', '   '])('falls back to defaults for blank env (%j), never NaN', (blank) => {
    process.env.DB_POOL_MAX = blank;
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = blank;
    process.env.DB_POOL_IDLE_TIMEOUT_MS = blank;

    const { database } = configuration();

    expect(database.poolMax).toBe(10);
    expect(database.connectionTimeoutMs).toBe(5000);
    expect(database.idleTimeoutMs).toBe(10000);
  });
});
