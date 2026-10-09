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
};

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_SUCCESS_URL: 'https://shop.jcool.test/payments/success?session_id={CHECKOUT_SESSION_ID}',
};

describe('env validation', () => {
  it('refuses to boot in production until TRUST_PROXY is set to anything', () => {
    const production = { ...BASE_ENV, NODE_ENV: NodeEnv.Production };

    expect(() => validate(production)).toThrow(/TRUST_PROXY/);
    for (const value of ['fd12::/16', '1', 'false']) {
      expect(() => validate({ ...production, ...STRIPE_ENV, TRUST_PROXY: value }), value).not.toThrow();
    }
  });

  it('leaves TRUST_PROXY optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  // Railway never sets PAYMENT_PROVIDER, so a guard keyed on it would never run there.
  it('refuses to boot in production without a Stripe key and success URL, whatever the provider says', () => {
    const production = { ...BASE_ENV, NODE_ENV: NodeEnv.Production, TRUST_PROXY: '1' };

    expect(() => validate(production)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => validate({ ...production, STRIPE_SECRET_KEY: STRIPE_ENV.STRIPE_SECRET_KEY })).toThrow(
      /STRIPE_SUCCESS_URL/,
    );
    expect(() => validate({ ...production, ...STRIPE_ENV })).not.toThrow();
  });

  it('keeps the network-free Stripe path outside production', () => {
    for (const nodeEnv of [NodeEnv.Test, NodeEnv.Development]) {
      expect(() => validate({ ...BASE_ENV, NODE_ENV: nodeEnv }), nodeEnv).not.toThrow();
    }
  });

  it('bounds the session floor and the capture timeout', () => {
    const refused: Array<[string, string]> = [
      ['PAYMENT_SESSION_MIN_TTL_SEC', '-1'],
      ['PAYMENT_SESSION_EXPIRY_MARGIN_SEC', '-1'],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '99'],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '60001'],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '1e4'],
    ];
    for (const [key, value] of refused) {
      expect(() => validate({ ...BASE_ENV, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    }

    // Zero floors are what a stack on a fake Stripe runs with, in production mode too.
    expect(() =>
      validate({
        ...BASE_ENV,
        NODE_ENV: NodeEnv.Production,
        TRUST_PROXY: '1',
        ...STRIPE_ENV,
        PAYMENT_SESSION_MIN_TTL_SEC: '0',
        PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
        PAYMENT_CAPTURE_TIMEOUT_MS: '1000',
      }),
    ).not.toThrow();
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

  it('caps the order.paid retry budget', () => {
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '31' })).toThrow(/ORDER_PAID_CONSUMER_ATTEMPTS/);
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '15' })).not.toThrow();
  });

  it('bounds the lapsed hold sweep and the Try lock budget', () => {
    const refused: Array<[string, string]> = [
      ['INVENTORY_HOLD_SWEEP_ENABLED', '0'],
      ['INVENTORY_HOLD_SWEEP_INTERVAL_MS', '999'],
      ['INVENTORY_HOLD_SWEEP_INTERVAL_MS', '3600001'],
      ['INVENTORY_HOLD_SWEEP_BATCH_SIZE', '0'],
      ['INVENTORY_HOLD_SWEEP_BATCH_SIZE', '501'],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '99'],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '30001'],
      ['INVENTORY_TRY_LOCK_TIMEOUT_MS', '2e3'],
    ];
    for (const [key, value] of refused) {
      expect(() => validate({ ...BASE_ENV, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    }

    expect(() =>
      validate({
        ...BASE_ENV,
        INVENTORY_HOLD_SWEEP_ENABLED: 'false',
        INVENTORY_HOLD_SWEEP_INTERVAL_MS: '3600000',
        INVENTORY_HOLD_SWEEP_BATCH_SIZE: '500',
        INVENTORY_TRY_LOCK_TIMEOUT_MS: '30000',
        CHECKOUT_TRY_TIMEOUT_MS: '30001',
      }),
    ).not.toThrow();
  });

  describe('checkout saga', () => {
    // The fault suite's short timings, as the api runs them while every participant is in-process.
    const SHORT = {
      PAYMENT_SESSION_MIN_TTL_SEC: '0',
      PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
      PAYMENT_CAPTURE_TIMEOUT_MS: '1000',
      INVENTORY_TRY_LOCK_TIMEOUT_MS: '600',
      CHECKOUT_PAYMENT_DEADLINE_SEC: '45',
      CHECKOUT_PAY_CUTOFF_SEC: '30',
      CHECKOUT_TRY_TIMEOUT_MS: '1000',
      CHECKOUT_HOLD_SAFETY_SEC: '30',
      SAGA_RUNNER_INTERVAL_MS: '500',
      SAGA_RETRY_BASE_MS: '200',
      SAGA_RETRY_CAP_MS: '2000',
      SAGA_LEASE_MS: '11000',
      SAGA_AUTH_GRACE_SEC: '5',
    };

    it('boots on the defaults and on the short fault-suite timings', () => {
      expect(() => validate(BASE_ENV)).not.toThrow();
      expect(() => validate({ ...BASE_ENV, ...SHORT })).not.toThrow();
    });

    it('bounds each saga setting on its own', () => {
      const refused: Array<[string, string]> = [
        ['SAGA_RUNNER_ENABLED', '1'],
        ['SAGA_RUNNER_INTERVAL_MS', '99'],
        ['SAGA_RUNNER_BATCH_SIZE', '0'],
        ['SAGA_RUNNER_BATCH_SIZE', '501'],
        ['SAGA_LEASE_MS', '999'],
        ['SAGA_RETRY_BASE_MS', '99'],
        ['SAGA_RETRY_CAP_MS', '99'],
        ['SAGA_KICK_CONCURRENCY', '0'],
        ['SAGA_AUTH_GRACE_SEC', '-1'],
        ['CHECKOUT_TRY_TIMEOUT_MS', '99'],
        ['CHECKOUT_PAYMENT_DEADLINE_SEC', '0'],
        ['CHECKOUT_HOLD_SAFETY_SEC', '0'],
        ['RETENTION_REJECTED_ORDER_DAYS', '0'],
      ];
      for (const [key, value] of refused) {
        expect(() => validate({ ...BASE_ENV, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
      }
    });

    it('keeps the lease longer than the slowest participant call it covers', () => {
      // A payment cancel makes up to four gateway calls of PAYMENT_CAPTURE_TIMEOUT_MS each.
      expect(() => validate({ ...BASE_ENV, PAYMENT_CAPTURE_TIMEOUT_MS: '13750', SAGA_LEASE_MS: '60000' })).toThrow(
        /SAGA_LEASE_MS/,
      );
      expect(() =>
        validate({ ...BASE_ENV, PAYMENT_CAPTURE_TIMEOUT_MS: '13749', SAGA_LEASE_MS: '60000' }),
      ).not.toThrow();
      expect(() => validate({ ...BASE_ENV, ...SHORT, CHECKOUT_TRY_TIMEOUT_MS: '6000' })).toThrow(/SAGA_LEASE_MS/);
    });

    it("keeps inventory's whole-Try budget inside the checkout's Try timeout", () => {
      expect(() => validate({ ...BASE_ENV, INVENTORY_TRY_LOCK_TIMEOUT_MS: '3000' })).toThrow(
        /INVENTORY_TRY_LOCK_TIMEOUT_MS/,
      );
      expect(() => validate({ ...BASE_ENV, INVENTORY_TRY_LOCK_TIMEOUT_MS: '2999' })).not.toThrow();
    });

    it('keeps the hold alive through the authorization grace', () => {
      expect(() => validate({ ...BASE_ENV, SAGA_AUTH_GRACE_SEC: '3600' })).toThrow(/SAGA_AUTH_GRACE_SEC/);
      expect(() => validate({ ...BASE_ENV, SAGA_AUTH_GRACE_SEC: '3599' })).not.toThrow();
    });

    it('leaves the HTTP path a connection when queue workers and saga kicks are all busy', () => {
      expect(() => validate({ ...BASE_ENV, QUEUE_WORKER_CONCURRENCY: '8' })).toThrow(/SAGA_KICK_CONCURRENCY/);
      expect(() => validate({ ...BASE_ENV, QUEUE_WORKER_CONCURRENCY: '7' })).not.toThrow();
      expect(() => validate({ ...BASE_ENV, SAGA_KICK_CONCURRENCY: '4', DB_POOL_MAX: '12' })).not.toThrow();
    });

    it('closes /pay early enough for the shortest session the gateway accepts', () => {
      expect(() => validate({ ...BASE_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1949' })).toThrow(/CHECKOUT_PAY_CUTOFF_SEC/);
      expect(() => validate({ ...BASE_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1950' })).not.toThrow();
    });

    it('keeps the payment deadline past the /pay cutoff', () => {
      expect(() => validate({ ...BASE_ENV, CHECKOUT_PAYMENT_DEADLINE_SEC: '1980' })).toThrow(
        /CHECKOUT_PAYMENT_DEADLINE_SEC/,
      );
      expect(() => validate({ ...BASE_ENV, CHECKOUT_PAYMENT_DEADLINE_SEC: '1981' })).not.toThrow();
    });
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
