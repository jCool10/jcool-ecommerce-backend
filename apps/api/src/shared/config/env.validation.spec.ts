import 'reflect-metadata'; // class-validator decorators; the app gets it from @nestjs/core's bootstrap.
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

// The minimum a boot needs to get past every other required var, so each case below isolates one.
const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_JWKS_URL: 'http://user-service.railway.internal:3000/.well-known/jwks.json',
  JWT_ISSUER: 'https://api.jcool.test',
  JWT_AUDIENCE: 'jcool',
  USER_SERVICE_INTERNAL_URL: 'http://user-service.railway.internal:3000',
  INTERNAL_API_TOKEN: 'internal-api-token-not-a-real-secret-0000',
};

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

describe('env validation — the user-service the api depends on', () => {
  // Without any one of these the api boots and then refuses every caller, so each is required.
  it.each(['AUTH_JWKS_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'USER_SERVICE_INTERNAL_URL', 'INTERNAL_API_TOKEN'])(
    'refuses to boot without %s',
    (key) => {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without)).toThrow(new RegExp(key));
    },
  );

  it('refuses a short internal token', () => {
    expect(() => validate({ ...BASE_ENV, INTERNAL_API_TOKEN: 'a'.repeat(31) })).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('refuses a user-service address without a scheme', () => {
    expect(() => validate({ ...BASE_ENV, USER_SERVICE_INTERNAL_URL: 'user-service:3000' })).toThrow(
      /USER_SERVICE_INTERNAL_URL/,
    );
  });

  it('refuses a JWKS address that is not a URL', () => {
    expect(() => validate({ ...BASE_ENV, AUTH_JWKS_URL: 'jwks.json' })).toThrow(/AUTH_JWKS_URL/);
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
