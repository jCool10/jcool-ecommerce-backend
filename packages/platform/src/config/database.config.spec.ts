import { afterEach, describe, expect, it } from 'vitest';
import { databaseConfig } from './database.config';

describe('databaseConfig — query timeout', () => {
  const saved = process.env.DB_QUERY_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.DB_QUERY_TIMEOUT_MS;
    else process.env.DB_QUERY_TIMEOUT_MS = saved;
  });

  // pg reads 0 as "no timeout", so leaving it unset keeps every existing pool exactly as it was.
  it.each([undefined, '', '  '])('stays off when the env is %j', (raw) => {
    if (raw === undefined) delete process.env.DB_QUERY_TIMEOUT_MS;
    else process.env.DB_QUERY_TIMEOUT_MS = raw;

    expect(databaseConfig().database.queryTimeoutMs).toBe(0);
  });

  it('honors an override', () => {
    process.env.DB_QUERY_TIMEOUT_MS = '2000';

    expect(databaseConfig().database.queryTimeoutMs).toBe(2000);
  });
});
