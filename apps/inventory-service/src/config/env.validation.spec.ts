import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';
import { validate } from './env.validation';

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/inventory',
  REDIS_URL: 'redis://localhost:6379',
  ID_SERVICE_URL: 'http://gateway:4000',
  AUTH_JWKS_URL: 'http://user-service:3000/.well-known/jwks.json',
  JWT_ISSUER: 'https://users.test.invalid',
  JWT_AUDIENCE: 'jcool-api',
  USER_SERVICE_URL: 'http://user-service:3000',
  USER_SERVICE_TOKEN: 'u'.repeat(32),
  CATALOG_PUBLIC_URL: 'http://gateway:8080',
};

/** The validation message, or null when the environment is accepted. */
function refusal(env: Record<string, unknown>): string | null {
  try {
    validate(env);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('validate', () => {
  it('accepts the minimal set and names each required variable that is missing', () => {
    const required = [
      'ID_SERVICE_URL',
      'AUTH_JWKS_URL',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'USER_SERVICE_URL',
      'USER_SERVICE_TOKEN',
      'CATALOG_PUBLIC_URL',
    ];

    expect(refusal(BASE)).toBeNull();
    expect(required.filter((name) => refusal({ ...BASE, [name]: undefined })?.includes(name))).toEqual(required);
  });

  // Only the guard refuses a service with no caller at all, so a caller can be added or dropped while
  // the service still runs the code that predates it.
  it('takes every caller token as optional, but none shorter than 32 characters', () => {
    const tokens = [
      'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
      'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
      'USER_SERVICE_TOKEN',
    ];

    expect(refusal({ ...BASE, INTERNAL_CALLER_TOKEN_ORDER_SERVICE: 'o'.repeat(32) })).toBeNull();
    expect(tokens.filter((name) => refusal({ ...BASE, [name]: 'a'.repeat(31) })?.includes(name))).toEqual(tokens);
  });

  it('bounds the stock settings as before they moved here', () => {
    const cases: Array<[string, string, boolean]> = [
      ['INVENTORY_LOCK_STRATEGY', 'optimistic', true],
      ['INVENTORY_LOCK_STRATEGY', 'mutex', false],
      ['INVENTORY_OPTIMISTIC_MAX_RETRIES', '10', true],
      ['INVENTORY_OPTIMISTIC_MAX_RETRIES', '11', false],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '99', false],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '100', true],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '30000', true],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '30001', false],
      ['INVENTORY_HOLD_SWEEP_INTERVAL_MS', '999', false],
      ['INVENTORY_HOLD_SWEEP_INTERVAL_MS', '1000', true],
      ['INVENTORY_HOLD_SWEEP_BATCH_SIZE', '0', false],
      ['INVENTORY_HOLD_SWEEP_BATCH_SIZE', '500', true],
      ['INVENTORY_HOLD_SWEEP_BATCH_SIZE', '501', false],
      ['INVENTORY_HOLD_SWEEP_ENABLED', '0', false],
      ['INVENTORY_HOLD_SWEEP_ENABLED', 'false', true],
    ];

    const wrong = cases.filter(([key, value, valid]) => (refusal({ ...BASE, [key]: value }) === null) !== valid);

    expect(wrong).toEqual([]);
  });

  it('refuses a user-service, JWKS or catalog address that is not an http URL', () => {
    const urls = ['USER_SERVICE_URL', 'AUTH_JWKS_URL', 'CATALOG_PUBLIC_URL'];

    expect(urls.filter((name) => refusal({ ...BASE, [name]: 'gateway:8080' })?.includes(name))).toEqual(urls);
  });

  it('requires TRUST_PROXY in production', () => {
    expect(refusal({ ...BASE, NODE_ENV: 'production' })).toContain('TRUST_PROXY');
    expect(refusal({ ...BASE, NODE_ENV: 'production', TRUST_PROXY: 'fd12::/16' })).toBeNull();
  });
});

describe('configuration', () => {
  const keys = [
    'INVENTORY_LOCK_STRATEGY',
    'INVENTORY_OPTIMISTIC_MAX_RETRIES',
    'INVENTORY_TRY_LOCK_TIMEOUT_MS',
    'INVENTORY_HOLD_SWEEP_ENABLED',
    'INVENTORY_HOLD_SWEEP_INTERVAL_MS',
    'INVENTORY_HOLD_SWEEP_BATCH_SIZE',
    'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
    'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
    'USER_SERVICE_URL',
    'USER_SERVICE_TOKEN',
    'USER_SERVICE_TIMEOUT_MS',
  ];
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

  it('keeps the stock defaults the api had', () => {
    expect(configuration().inventory).toEqual({
      lockStrategy: 'pessimistic',
      optimisticMaxRetries: 3,
      tryLockTimeoutMs: 2_000,
      holdSweep: { enabled: true, intervalMs: 60_000, batchSize: 50 },
    });
  });

  // `attempt >= NaN` is always false, so a NaN budget would leave the CAS loop unbounded.
  it('falls back to the default retry budget for a blank value', () => {
    const budgets = ['', '   '].map((blank) => {
      process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES = blank;
      return configuration().inventory.optimisticMaxRetries;
    });

    expect(budgets).toEqual([3, 3]);
  });

  it('accepts only the order-service as a caller, with a current and previous token', () => {
    process.env.INTERNAL_CALLER_TOKEN_ORDER_SERVICE = 'order-current';
    process.env.INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS = 'order-previous';

    expect(configuration().internalApi.callers).toEqual({ 'order-service': ['order-current', 'order-previous'] });
  });

  it('maps its user-service credentials onto the keys the shared client reads', () => {
    process.env.USER_SERVICE_URL = 'http://user-service:3000';
    process.env.USER_SERVICE_TOKEN = 'token';

    expect(configuration().userService).toEqual({ url: 'http://user-service:3000', token: 'token', timeoutMs: 500 });
  });
});
