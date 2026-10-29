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
  ID_SERVICE_URL: 'http://gateway.railway.internal:4000',
  INVENTORY_SERVICE_URL: 'http://inventory-service.railway.internal:3000',
  INVENTORY_SERVICE_TOKEN: 'inventory-service-token-not-a-real-secret-00',
  PAYMENT_SERVICE_URL: 'http://payment-service.railway.internal:3000',
  PAYMENT_SERVICE_TOKEN: 'payment-service-token-not-a-real-secret-000',
};

// Also required in production; covered on their own in checkout-saga.env.spec.ts.
const TEMPORAL_ENV = {
  TEMPORAL_ADDRESS: 'temporal.railway.internal:7233',
  TEMPORAL_NAMESPACE: 'jcool',
  TEMPORAL_TASK_QUEUE: 'checkout-saga',
};

describe('env validation', () => {
  it('refuses to boot in production until TRUST_PROXY is set to anything', () => {
    const production = { ...BASE_ENV, ...TEMPORAL_ENV, NODE_ENV: NodeEnv.Production };

    expect(() => validate(production)).toThrow(/TRUST_PROXY/);
    for (const value of ['fd12::/16', '1', 'false']) {
      expect(() => validate({ ...production, TRUST_PROXY: value }), value).not.toThrow();
    }
  });

  it('leaves TRUST_PROXY optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  // Stripe lives in the payment-service now, along with its boot guard.
  it('boots in production with no Stripe setting at all', () => {
    const production = { ...BASE_ENV, ...TEMPORAL_ENV, NODE_ENV: NodeEnv.Production, TRUST_PROXY: 'false' };

    expect(() => validate(production)).not.toThrow();
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

  it('refuses to boot without an http id-service address', () => {
    const { ID_SERVICE_URL: _, ...without } = BASE_ENV;

    expect(() => validate(without)).toThrow(/ID_SERVICE_URL/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_URL: 'gateway:4000' })).toThrow(/ID_SERVICE_URL/);
  });

  it('bounds the id-service timeout', () => {
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '99' })).toThrow(/ID_SERVICE_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '2e3' })).toThrow(/ID_SERVICE_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '2000' })).not.toThrow();
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

  it('refuses to boot without the inventory-service address or its token', () => {
    for (const key of ['INVENTORY_SERVICE_URL', 'INVENTORY_SERVICE_TOKEN']) {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(key));
    }
    expect(() => validate({ ...BASE_ENV, INVENTORY_SERVICE_URL: 'inventory-service:3000' })).toThrow(
      /INVENTORY_SERVICE_URL/,
    );
    expect(() => validate({ ...BASE_ENV, INVENTORY_SERVICE_TOKEN: 'a'.repeat(31) })).toThrow(/INVENTORY_SERVICE_TOKEN/);
  });

  it('bounds the inventory command timeout', () => {
    expect(() => validate({ ...BASE_ENV, INVENTORY_COMMAND_TIMEOUT_MS: '99' })).toThrow(/INVENTORY_COMMAND_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, INVENTORY_COMMAND_TIMEOUT_MS: '5e3' })).toThrow(
      /INVENTORY_COMMAND_TIMEOUT_MS/,
    );
    expect(() => validate({ ...BASE_ENV, INVENTORY_COMMAND_TIMEOUT_MS: '5000' })).not.toThrow();
  });

  it('refuses to boot without the payment-service address or its token', () => {
    for (const key of ['PAYMENT_SERVICE_URL', 'PAYMENT_SERVICE_TOKEN']) {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(key));
    }
    expect(() => validate({ ...BASE_ENV, PAYMENT_SERVICE_URL: 'payment-service:3000' })).toThrow(/PAYMENT_SERVICE_URL/);
    expect(() => validate({ ...BASE_ENV, PAYMENT_SERVICE_TOKEN: 'a'.repeat(31) })).toThrow(/PAYMENT_SERVICE_TOKEN/);
  });

  it('bounds the payment command timeout', () => {
    expect(() => validate({ ...BASE_ENV, PAYMENT_COMMAND_TIMEOUT_MS: '999' })).toThrow(/PAYMENT_COMMAND_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, PAYMENT_COMMAND_TIMEOUT_MS: '45e3' })).toThrow(/PAYMENT_COMMAND_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, PAYMENT_COMMAND_TIMEOUT_MS: '1000' })).not.toThrow();
  });

  it('caps the order.paid retry budget', () => {
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '31' })).toThrow(/ORDER_PAID_CONSUMER_ATTEMPTS/);
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '15' })).not.toThrow();
  });

  it('keeps a rejected order at least a day', () => {
    expect(() => validate({ ...BASE_ENV, RETENTION_REJECTED_ORDER_DAYS: '0' })).toThrow(
      /RETENTION_REJECTED_ORDER_DAYS/,
    );
    expect(() => validate({ ...BASE_ENV, RETENTION_REJECTED_ORDER_DAYS: '1' })).not.toThrow();
  });

  // The platform injects its own variables, and a retired key can linger in a deployment.
  it('boots with env keys the schema does not declare', () => {
    expect(() => validate({ ...BASE_ENV, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'not-a-number' })).not.toThrow();
  });

  // `parseIntOr` in configuration.ts reads with `parseInt`, which stops at the first non-digit:
  // '6e4' would load as 6ms, not 60000ms. Validation must refuse the value a loader would misread
  // rather than accept it and drift.
  it('refuses scientific-notation and hex integers that a loader would parse differently', () => {
    expect(() => validate({ ...BASE_ENV, OUTBOX_POLL_MS: '1e3' })).toThrow(/OUTBOX_POLL_MS/);
    expect(() => validate({ ...BASE_ENV, QUEUE_CONSUMER_BACKOFF_MS: '1e3' })).toThrow(/QUEUE_CONSUMER_BACKOFF_MS/);
    expect(() => validate({ ...BASE_ENV, OUTBOX_POLL_MS: '1000' })).not.toThrow();
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
