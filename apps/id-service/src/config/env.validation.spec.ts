import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

const BASE_ENV = { NODE_ENV: NodeEnv.Test, ETCD_ENDPOINTS: 'http://etcd:2379' };

describe('id-service env validation', () => {
  it('boots on the platform minimum and parses timings given as strings', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();

    const env = validate({ ...BASE_ENV, ID_LEASE_TTL_MS: '60000', ETCD_REQUEST_TIMEOUT_MS: '2000' });
    expect([env.ID_LEASE_TTL_MS, env.ETCD_REQUEST_TIMEOUT_MS]).toEqual([60_000, 2_000]);
  });

  it('accepts a list of etcd endpoints and refuses anything else', () => {
    expect(() => validate({ ...BASE_ENV, ETCD_ENDPOINTS: 'http://a:2379, https://b:2379' })).not.toThrow();

    for (const value of ['', 'etcd:2379', 'http://a:2379,', 'postgresql://ids@id-postgres:5432/ids']) {
      expect(() => validate({ ...BASE_ENV, ETCD_ENDPOINTS: value }), value).toThrow(/ETCD_ENDPOINTS/);
    }
    const { ETCD_ENDPOINTS: _, ...withoutEndpoints } = BASE_ENV;
    expect(() => validate(withoutEndpoints)).toThrow(/ETCD_ENDPOINTS/);
  });

  it('refuses a key prefix that is not a slash-delimited path', () => {
    expect(() => validate({ ...BASE_ENV, ETCD_KEY_PREFIX: '/jcool/id-service/' })).not.toThrow();

    for (const value of ['/', 'jcool/id-service/', '/jcool/id-service']) {
      expect(() => validate({ ...BASE_ENV, ETCD_KEY_PREFIX: value }), value).toThrow(/ETCD_KEY_PREFIX/);
    }
  });

  it('refuses a lease timing below its floor or not an integer', () => {
    const invalid = [
      ['ID_LEASE_TTL_MS', '999'],
      ['ID_LEASE_TTL_MS', '1500.5'],
      ['ID_LEASE_RENEW_EVERY_MS', '99'],
      ['ID_LEASE_FENCE_MARGIN_MS', 'soon'],
      ['ID_LEASE_MAX_FLOOR_AHEAD_MS', '-5'],
    ];

    for (const [key, value] of invalid) {
      expect(() => validate({ ...BASE_ENV, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    }
  });

  // A renew against an etcd that hangs must give up, or it stalls the keeper for good.
  it('refuses an etcd request timeout of 0', () => {
    expect(() => validate({ ...BASE_ENV, ETCD_REQUEST_TIMEOUT_MS: '0' })).toThrow(/ETCD_REQUEST_TIMEOUT_MS/);
  });

  // The loader (`msEnv`) reads with `Number`, the validator with a strict integer parse: '2e3' must be
  // refused rather than loaded as 2000 by one and something else by the other.
  it('refuses scientific-notation timings', () => {
    expect(() => validate({ ...BASE_ENV, ETCD_REQUEST_TIMEOUT_MS: '2e3' })).toThrow(/ETCD_REQUEST_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_LEASE_TTL_MS: '6e4' })).toThrow(/ID_LEASE_TTL_MS/);
  });
});
