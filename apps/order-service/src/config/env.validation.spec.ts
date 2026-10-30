import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/order',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_JWKS_URL: 'http://user-service.railway.internal:3000/.well-known/jwks.json',
  JWT_ISSUER: 'https://api.jcool.test',
  JWT_AUDIENCE: 'jcool',
  USER_SERVICE_URL: 'http://user-service.railway.internal:3000',
  USER_SERVICE_TOKEN: 'user-service-token-not-a-real-secret-00000',
  ID_SERVICE_URL: 'http://gateway.railway.internal:4000',
  API_SERVICE_URL: 'http://api.railway.internal:8080',
  API_SERVICE_TOKEN: 'api-service-token-not-a-real-secret-000000',
  INVENTORY_SERVICE_URL: 'http://inventory-service.railway.internal:3000',
  INVENTORY_SERVICE_TOKEN: 'inventory-service-token-not-a-real-secret-00',
  PAYMENT_SERVICE_URL: 'http://payment-service.railway.internal:3000',
  PAYMENT_SERVICE_TOKEN: 'payment-service-token-not-a-real-secret-000',
};

const PRODUCTION_ENV = {
  ...BASE_ENV,
  NODE_ENV: NodeEnv.Production,
  TEMPORAL_ADDRESS: 'temporal.railway.internal:7233',
  TEMPORAL_NAMESPACE: 'jcool',
  TEMPORAL_TASK_QUEUE: 'checkout-saga',
};

describe('env validation', () => {
  it('refuses to boot in production until TRUST_PROXY is set to anything', () => {
    expect(() => validate(PRODUCTION_ENV)).toThrow(/TRUST_PROXY/);
    for (const value of ['fd12::/16', '1', 'false']) {
      expect(() => validate({ ...PRODUCTION_ENV, TRUST_PROXY: value }), value).not.toThrow();
    }
  });

  it('leaves TRUST_PROXY optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  it('refuses to boot without an address or token it calls out with', () => {
    const required = [
      'AUTH_JWKS_URL',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'USER_SERVICE_URL',
      'USER_SERVICE_TOKEN',
      'ID_SERVICE_URL',
      'API_SERVICE_URL',
      'API_SERVICE_TOKEN',
      'INVENTORY_SERVICE_URL',
      'INVENTORY_SERVICE_TOKEN',
      'PAYMENT_SERVICE_URL',
      'PAYMENT_SERVICE_TOKEN',
    ];
    for (const key of required) {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(key));
    }
  });

  it('refuses an address that is not an http URL', () => {
    const urls = [
      'USER_SERVICE_URL',
      'ID_SERVICE_URL',
      'API_SERVICE_URL',
      'INVENTORY_SERVICE_URL',
      'PAYMENT_SERVICE_URL',
    ];
    for (const key of urls) {
      expect(() => validate({ ...BASE_ENV, [key]: 'service:3000' }), key).toThrow(new RegExp(key));
    }
  });

  it('refuses a token shorter than 32 characters', () => {
    const tokens = ['USER_SERVICE_TOKEN', 'API_SERVICE_TOKEN', 'INVENTORY_SERVICE_TOKEN', 'PAYMENT_SERVICE_TOKEN'];
    for (const key of tokens) {
      expect(() => validate({ ...BASE_ENV, [key]: 'a'.repeat(31) }), key).toThrow(new RegExp(key));
    }
  });

  it('bounds every outbound timeout', () => {
    const cases: Array<[string, string, boolean]> = [
      ['API_SERVICE_TIMEOUT_MS', '99', false],
      ['API_SERVICE_TIMEOUT_MS', '100', true],
      ['API_SERVICE_TIMEOUT_MS', '2e3', false],
      ['ID_SERVICE_TIMEOUT_MS', '99', false],
      ['USER_SERVICE_TIMEOUT_MS', '99', false],
      ['INVENTORY_COMMAND_TIMEOUT_MS', '99', false],
      ['INVENTORY_COMMAND_TIMEOUT_MS', '5000', true],
      ['PAYMENT_COMMAND_TIMEOUT_MS', '999', false],
      ['PAYMENT_COMMAND_TIMEOUT_MS', '1000', true],
    ];

    const wrong = cases.filter(([key, value, valid]) => {
      try {
        validate({ ...BASE_ENV, [key]: value });
        return !valid;
      } catch (error) {
        return valid || !(error as Error).message.includes(key);
      }
    });

    expect(wrong).toEqual([]);
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

  // `parseIntOr` stops at the first non-digit, so '1e3' would load as 1.
  it('refuses scientific-notation integers that a loader would parse differently', () => {
    expect(() => validate({ ...BASE_ENV, OUTBOX_POLL_MS: '1e3' })).toThrow(/OUTBOX_POLL_MS/);
    expect(() => validate({ ...BASE_ENV, QUEUE_CONSUMER_BACKOFF_MS: '1e3' })).toThrow(/QUEUE_CONSUMER_BACKOFF_MS/);
    expect(() => validate({ ...BASE_ENV, OUTBOX_POLL_MS: '1000' })).not.toThrow();
  });

  it("refuses '0'/'1' for boolean switches instead of loading the opposite of what was set", () => {
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: '0' })).toThrow(/OUTBOX_RELAY_ENABLED/);
    expect(() => validate({ ...BASE_ENV, QUEUE_WORKER_ENABLED: '1' })).toThrow(/QUEUE_WORKER_ENABLED/);
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: 'false', QUEUE_WORKER_ENABLED: 'true' })).not.toThrow();
  });
});
