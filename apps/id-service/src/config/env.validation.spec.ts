import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

const BASE_ENV = { NODE_ENV: NodeEnv.Test, DATABASE_URL: 'postgresql://user:pw@localhost:5432/ids' };

describe('id-service env validation', () => {
  it('boots on the platform minimum, every lease timing left to its default', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  it('parses lease timings given as strings', () => {
    expect(validate({ ...BASE_ENV, ID_LEASE_TTL_MS: '60000' }).ID_LEASE_TTL_MS).toBe(60_000);
  });

  it.each([
    ['ID_LEASE_TTL_MS', '999'],
    ['ID_LEASE_TTL_MS', '1500.5'],
    ['ID_LEASE_RENEW_EVERY_MS', '99'],
    ['ID_LEASE_QUARANTINE_MS', '-1'],
    ['ID_LEASE_FENCE_MARGIN_MS', 'soon'],
    ['ID_LEASE_MAX_FLOOR_AHEAD_MS', '-5'],
    // 0 means wait forever to pg, and a renew that never settles stalls the keeper for good.
    ['DB_QUERY_TIMEOUT_MS', '0'],
    ['DB_POOL_CONNECTION_TIMEOUT_MS', '0'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => validate({ ...BASE_ENV, [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts bounded database timeouts', () => {
    const env = validate({ ...BASE_ENV, DB_QUERY_TIMEOUT_MS: '2000', DB_POOL_CONNECTION_TIMEOUT_MS: '5000' });
    expect([env.DB_QUERY_TIMEOUT_MS, env.DB_POOL_CONNECTION_TIMEOUT_MS]).toEqual([2_000, 5_000]);
  });
});
