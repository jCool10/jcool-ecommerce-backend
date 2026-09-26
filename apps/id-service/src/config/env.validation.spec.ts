import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

const BASE_ENV = { NODE_ENV: NodeEnv.Test, DATABASE_URL: 'postgresql://user:pw@localhost:5432/ids' };

describe('id-service env validation', () => {
  it('boots on the platform minimum and parses timings given as strings', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();

    const env = validate({
      ...BASE_ENV,
      ID_LEASE_TTL_MS: '60000',
      DB_QUERY_TIMEOUT_MS: '2000',
      DB_POOL_CONNECTION_TIMEOUT_MS: '5000',
    });
    expect([env.ID_LEASE_TTL_MS, env.DB_QUERY_TIMEOUT_MS, env.DB_POOL_CONNECTION_TIMEOUT_MS]).toEqual([
      60_000, 2_000, 5_000,
    ]);
  });

  it('refuses a lease timing below its floor or not an integer', () => {
    const invalid = [
      ['ID_LEASE_TTL_MS', '999'],
      ['ID_LEASE_TTL_MS', '1500.5'],
      ['ID_LEASE_RENEW_EVERY_MS', '99'],
      ['ID_LEASE_QUARANTINE_MS', '-1'],
      ['ID_LEASE_FENCE_MARGIN_MS', 'soon'],
      ['ID_LEASE_MAX_FLOOR_AHEAD_MS', '-5'],
    ];

    for (const [key, value] of invalid) {
      expect(() => validate({ ...BASE_ENV, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    }
  });

  // pg reads 0 as "wait forever", and a renew that never settles stalls the keeper for good. The
  // platform allows 0, so these keys are redeclared here with a floor of 1.
  it('refuses a database timeout of 0', () => {
    for (const key of ['DB_QUERY_TIMEOUT_MS', 'DB_POOL_CONNECTION_TIMEOUT_MS']) {
      expect(() => validate({ ...BASE_ENV, [key]: '0' }), key).toThrow(new RegExp(key));
    }
  });

  // The loader (`parseIntOr`, `msEnv`) reads with `parseInt`/`Number`, which stops at the first
  // non-digit: '2e3' would load as a 2ms query timeout, not 2000ms. These fields are redeclared on
  // the subclass, so this also proves the strict transform survives being applied twice.
  it('refuses scientific-notation timeouts on both the platform and the redeclared fields', () => {
    expect(() => validate({ ...BASE_ENV, DB_QUERY_TIMEOUT_MS: '2e3' })).toThrow(/DB_QUERY_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_LEASE_TTL_MS: '6e4' })).toThrow(/ID_LEASE_TTL_MS/);

    const env = validate({ ...BASE_ENV, DB_QUERY_TIMEOUT_MS: '2000', DB_POOL_CONNECTION_TIMEOUT_MS: '5000' });
    expect([env.DB_QUERY_TIMEOUT_MS, env.DB_POOL_CONNECTION_TIMEOUT_MS]).toEqual([2000, 5000]);
  });
});
