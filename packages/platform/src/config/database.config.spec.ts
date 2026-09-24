import { afterEach, describe, expect, it } from 'vitest';
import { databaseConfig } from './database.config';

const KEYS = ['DB_POOL_CONNECTION_TIMEOUT_MS', 'DB_QUERY_TIMEOUT_MS'] as const;

describe('databaseConfig', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // A blank value read as 0 would give pg a connection timeout of "wait forever".
  it('keeps the default connection timeout when the env is unset or blank', () => {
    const connectionTimeoutFor = (raw: string | undefined): number => {
      if (raw === undefined) delete process.env.DB_POOL_CONNECTION_TIMEOUT_MS;
      else process.env.DB_POOL_CONNECTION_TIMEOUT_MS = raw;
      return databaseConfig().database.connectionTimeoutMs;
    };

    expect([undefined, '', '  '].map(connectionTimeoutFor)).toEqual([5000, 5000, 5000]);
  });

  it('honors an override', () => {
    process.env.DB_QUERY_TIMEOUT_MS = '2000';

    expect(databaseConfig().database.queryTimeoutMs).toBe(2000);
  });
});
