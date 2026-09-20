import 'reflect-metadata'; // class-validator decorators; the app gets it from @nestjs/core's bootstrap.
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

// The minimum a boot needs to get past every other required var, so each case below isolates one.
const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-a-real-secret-000',
  IDENTITY_BUCKET_KEY: 'test-identity-bucket-key-not-a-real-secret-000',
};

describe('env validation — IDENTITY_BUCKET_KEY', () => {
  it('accepts a base env that carries the key', () => {
    expect(validate(BASE_ENV).IDENTITY_BUCKET_KEY).toBe(BASE_ENV.IDENTITY_BUCKET_KEY);
  });

  it('refuses to boot when the key is missing', () => {
    const { IDENTITY_BUCKET_KEY: _missing, ...withoutKey } = BASE_ENV;

    expect(() => validate(withoutKey)).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot when the key is shorter than 32 chars', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(31) })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot on an empty key (dotenv writes "" rather than leaving it unset)', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: '' })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('accepts exactly 32 chars', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(32) })).not.toThrow();
  });
});

describe('env validation — TRUST_PROXY', () => {
  const PRODUCTION_ENV = { ...BASE_ENV, NODE_ENV: NodeEnv.Production };

  it('refuses to boot in production when it is unset', () => {
    expect(() => validate(PRODUCTION_ENV)).toThrow(/TRUST_PROXY/);
  });

  it.each(['fd12::/16', '1', 'false'])('boots in production with %s', (value) => {
    expect(() => validate({ ...PRODUCTION_ENV, TRUST_PROXY: value })).not.toThrow();
  });

  it('leaves it optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });
});

describe('env validation — auth and user-directory modes', () => {
  const USER_SERVICE = {
    USER_SERVICE_INTERNAL_URL: 'http://user-service.railway.internal:3000',
    INTERNAL_API_TOKEN: 'internal-api-token-not-a-real-secret-0000',
  };

  it.each(['AUTH_HS256_ENABLED', 'AUTH_ROUTES_ENABLED', 'RETENTION_AUTH_TOKENS_ENABLED'])(
    'reads %s as true or false only',
    (key) => {
      expect(() => validate({ ...BASE_ENV, [key]: '0' })).toThrow(new RegExp(key));
      expect(() => validate({ ...BASE_ENV, [key]: 'false' })).not.toThrow();
    },
  );

  it.each([
    ['AUTH_EPOCH_SOURCE', 'postgres'],
    ['USER_DIRECTORY_SOURCE', 'http'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => validate({ ...BASE_ENV, ...USER_SERVICE, [key]: value })).toThrow(new RegExp(key));
  });

  it('needs no user-service while both modes stay local', () => {
    expect(() => validate({ ...BASE_ENV, AUTH_EPOCH_SOURCE: 'db', USER_DIRECTORY_SOURCE: 'local' })).not.toThrow();
  });

  it.each([
    ['AUTH_EPOCH_SOURCE', 'redis'],
    ['USER_DIRECTORY_SOURCE', 'remote'],
  ])('needs the user-service address and token once %s=%s', (key, value) => {
    expect(() => validate({ ...BASE_ENV, [key]: value })).toThrow(/USER_SERVICE_INTERNAL_URL/);
    expect(() => validate({ ...BASE_ENV, [key]: value })).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => validate({ ...BASE_ENV, ...USER_SERVICE, [key]: value })).not.toThrow();
  });

  it('refuses a short internal token', () => {
    expect(() =>
      validate({ ...BASE_ENV, ...USER_SERVICE, AUTH_EPOCH_SOURCE: 'redis', INTERNAL_API_TOKEN: 'a'.repeat(31) }),
    ).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('refuses a user-service address without a scheme', () => {
    const schemeless = { ...USER_SERVICE, USER_SERVICE_INTERNAL_URL: 'user-service:3000' };

    expect(() => validate({ ...BASE_ENV, ...schemeless, AUTH_EPOCH_SOURCE: 'redis' })).toThrow(
      /USER_SERVICE_INTERNAL_URL/,
    );
  });

  it('trusts an issuer only with its name and audience', () => {
    const jwks = { AUTH_JWKS_URL: 'http://user-service.railway.internal:3000/.well-known/jwks.json' };

    expect(() => validate({ ...BASE_ENV, ...jwks })).toThrow(/JWT_ISSUER/);
    expect(() => validate({ ...BASE_ENV, ...jwks })).toThrow(/JWT_AUDIENCE/);
    expect(() =>
      validate({ ...BASE_ENV, ...jwks, JWT_ISSUER: 'https://api.jcool.test', JWT_AUDIENCE: 'jcool' }),
    ).not.toThrow();
  });

  it('refuses a JWKS address that is not a URL', () => {
    const issuer = { JWT_ISSUER: 'https://api.jcool.test', JWT_AUDIENCE: 'jcool' };

    expect(() => validate({ ...BASE_ENV, ...issuer, AUTH_JWKS_URL: 'jwks.json' })).toThrow(/AUTH_JWKS_URL/);
  });

  it('caps the order.paid retry budget', () => {
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '31' })).toThrow(/ORDER_PAID_CONSUMER_ATTEMPTS/);
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '15' })).not.toThrow();
  });
});

describe('env validation — retired inventory backoff key', () => {
  // validateSync runs without forbidNonWhitelisted, so an undeclared key is ignored while a
  // declared one can still fail a boot. Nothing reads this key any more, so it must stay undeclared
  // or a deployment that still carries it is the only thing the schema can reject.
  it('ignores a stale INVENTORY_OPTIMISTIC_BACKOFF_MS instead of refusing to boot', () => {
    expect(() => validate({ ...BASE_ENV, INVENTORY_OPTIMISTIC_BACKOFF_MS: 'not-a-number' })).not.toThrow();
  });
});
