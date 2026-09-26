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

describe('env validation', () => {
  it('refuses to boot in production until TRUST_PROXY is set to anything', () => {
    const production = { ...BASE_ENV, NODE_ENV: NodeEnv.Production };

    expect(() => validate(production)).toThrow(/TRUST_PROXY/);
    for (const value of ['fd12::/16', '1', 'false']) {
      expect(() => validate({ ...production, TRUST_PROXY: value }), value).not.toThrow();
    }
  });

  it('leaves TRUST_PROXY optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  // Without any one of these the api boots and then refuses every caller.
  it('refuses to boot without a setting the user-service link needs', () => {
    const required = ['AUTH_JWKS_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'USER_SERVICE_INTERNAL_URL', 'INTERNAL_API_TOKEN'];
    for (const key of required) {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(key));
    }
  });

  it('refuses a short internal token', () => {
    expect(() => validate({ ...BASE_ENV, INTERNAL_API_TOKEN: 'a'.repeat(31) })).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('refuses a user-service or JWKS address that is not an http URL', () => {
    expect(() => validate({ ...BASE_ENV, USER_SERVICE_INTERNAL_URL: 'user-service:3000' })).toThrow(
      /USER_SERVICE_INTERNAL_URL/,
    );
    expect(() => validate({ ...BASE_ENV, AUTH_JWKS_URL: 'jwks.json' })).toThrow(/AUTH_JWKS_URL/);
  });

  it('caps the order.paid retry budget', () => {
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '31' })).toThrow(/ORDER_PAID_CONSUMER_ATTEMPTS/);
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '15' })).not.toThrow();
  });

  // The platform injects its own variables, and a retired key can linger in a deployment.
  it('boots with env keys the schema does not declare', () => {
    expect(() => validate({ ...BASE_ENV, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'not-a-number' })).not.toThrow();
  });

  // `parseIntOr` in configuration.ts reads with `parseInt`, which stops at the first non-digit:
  // '6e4' would load as 6ms, not 60000ms. Validation must refuse the value a loader would misread
  // rather than accept it and drift.
  it('refuses scientific-notation and hex integers that a loader would parse differently', () => {
    expect(() => validate({ ...BASE_ENV, RECONCILE_INTERVAL_MS: '6e4' })).toThrow(/RECONCILE_INTERVAL_MS/);
    expect(() => validate({ ...BASE_ENV, QUEUE_CONSUMER_BACKOFF_MS: '1e3' })).toThrow(/QUEUE_CONSUMER_BACKOFF_MS/);
    expect(() => validate({ ...BASE_ENV, RECONCILE_INTERVAL_MS: '60000' })).not.toThrow();
  });

  // configuration.ts reads these with `!== 'false'` or `=== 'true'`, so '0'/'1' must be refused
  // instead of silently loading as the opposite of what they validated as.
  it("refuses '0'/'1' for boolean switches instead of loading the opposite of what was set", () => {
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: '0' })).toThrow(/OUTBOX_RELAY_ENABLED/);
    expect(() => validate({ ...BASE_ENV, SEARCH_ENABLED: '1' })).toThrow(/SEARCH_ENABLED/);
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: 'false', SEARCH_ENABLED: 'true' })).not.toThrow();
  });

  // app.config.ts compares COOKIE_SECURE to the literal 'true'; '1' must not validate and then load
  // as false, or a production auth cookie loses Secure.
  it('refuses a non-literal COOKIE_SECURE', () => {
    expect(() => validate({ ...BASE_ENV, COOKIE_SECURE: '1' })).toThrow(/COOKIE_SECURE/);
    expect(() => validate({ ...BASE_ENV, COOKIE_SECURE: 'true' })).not.toThrow();
  });
});
