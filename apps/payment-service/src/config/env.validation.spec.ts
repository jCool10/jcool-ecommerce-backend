import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import configuration from './configuration';
import { validate } from './env.validation';

const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/payment',
  REDIS_URL: 'redis://localhost:6379',
  ID_SERVICE_URL: 'http://gateway.railway.internal:4000',
};

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key_0000',
  STRIPE_SUCCESS_URL: 'https://shop.example.test/payments/success?session_id={CHECKOUT_SESSION_ID}',
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

describe('env validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the minimal set and names each required variable that is missing', () => {
    const required = ['DATABASE_URL', 'REDIS_URL', 'ID_SERVICE_URL'];

    expect(refusal(BASE_ENV)).toBeNull();
    expect(required.filter((name) => refusal({ ...BASE_ENV, [name]: undefined })?.includes(name))).toEqual(required);
  });

  it('refuses to boot in production without a Stripe key and success URL', () => {
    const production = { ...BASE_ENV, NODE_ENV: NodeEnv.Production };

    expect(() => validate(production)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => validate({ ...production, STRIPE_SECRET_KEY: STRIPE_ENV.STRIPE_SECRET_KEY })).toThrow(
      /STRIPE_SUCCESS_URL/,
    );
    expect(() => validate({ ...production, ...STRIPE_ENV })).not.toThrow();
  });

  it('lets test and development run offline without Stripe', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
    expect(() => validate({ ...BASE_ENV, NODE_ENV: NodeEnv.Development })).not.toThrow();
  });

  describe('a Stripe API host other than Stripe', () => {
    const FAKE = { STRIPE_API_HOST: 'fake-stripe', STRIPE_API_PORT: '12111', STRIPE_API_PROTOCOL: 'http' };
    const everyEnv = [NodeEnv.Test, NodeEnv.Development, NodeEnv.Production];

    it('takes a test key, in every NODE_ENV', () => {
      const refused = everyEnv.filter((env) => refusal({ ...BASE_ENV, ...STRIPE_ENV, ...FAKE, NODE_ENV: env }));

      expect(refused).toEqual([]);
    });

    it('refuses a live key, or no key, in every NODE_ENV', () => {
      const accepted = everyEnv.flatMap((env) =>
        [{ STRIPE_SECRET_KEY: 'sk_live_not_a_real_key_0000' }, { STRIPE_SECRET_KEY: undefined }]
          .filter((key) => refusal({ ...BASE_ENV, ...STRIPE_ENV, ...FAKE, ...key, NODE_ENV: env }) === null)
          .map((key) => `${env} ${key.STRIPE_SECRET_KEY}`),
      );

      expect(accepted).toEqual([]);
    });

    it('refuses plain http unless a host is named', () => {
      expect(refusal({ ...BASE_ENV, ...STRIPE_ENV, STRIPE_API_PROTOCOL: 'http' })).toContain('STRIPE_API_HOST');
      expect(refusal({ ...BASE_ENV, ...STRIPE_ENV, STRIPE_API_PROTOCOL: 'https' })).toBeNull();
    });

    it('bounds the port and the protocol', () => {
      const cases: Array<[string, string, boolean]> = [
        ['STRIPE_API_PORT', '0', false],
        ['STRIPE_API_PORT', '1', true],
        ['STRIPE_API_PORT', '65535', true],
        ['STRIPE_API_PORT', '65536', false],
        ['STRIPE_API_PORT', '80.5', false],
        ['STRIPE_API_PROTOCOL', 'ftp', false],
      ];

      const wrong = cases.filter(
        ([key, value, valid]) => (refusal({ ...BASE_ENV, ...STRIPE_ENV, ...FAKE, [key]: value }) === null) !== valid,
      );

      expect(wrong).toEqual([]);
    });
  });

  it('bounds the payment session floor and the capture timeout', () => {
    const cases: Array<[string, string, boolean]> = [
      ['PAYMENT_SESSION_MIN_TTL_SEC', '-1', false],
      ['PAYMENT_SESSION_MIN_TTL_SEC', '0', true],
      ['PAYMENT_SESSION_EXPIRY_MARGIN_SEC', '-1', false],
      ['PAYMENT_SESSION_EXPIRY_MARGIN_SEC', '0', true],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '499', false],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '500', true],
      ['PAYMENT_CAPTURE_TIMEOUT_MS', '1e4', false],
    ];
    for (const [key, value, valid] of cases) {
      const run = () => validate({ ...BASE_ENV, [key]: value });
      if (valid) expect(run, `${key}=${value}`).not.toThrow();
      else expect(run, `${key}=${value}`).toThrow(new RegExp(key));
    }
  });

  it('refuses a provider other than stripe and a webhook secret too short to be one', () => {
    expect(refusal({ ...BASE_ENV, PAYMENT_PROVIDER: 'paypal' })).toMatch(/PAYMENT_PROVIDER/);
    expect(refusal({ ...BASE_ENV, PAYMENT_WEBHOOK_SECRET: 'whsec_short' })).toMatch(/PAYMENT_WEBHOOK_SECRET/);
    expect(refusal({ ...BASE_ENV, PAYMENT_WEBHOOK_SECRET: 'whsec_long_enough_0000' })).toBeNull();
  });

  // Only the guard refuses a service with no caller at all.
  it('takes every caller token as optional, but none shorter than 32 characters', () => {
    const tokens = ['INTERNAL_CALLER_TOKEN_ORDER_SERVICE', 'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS'];

    expect(refusal({ ...BASE_ENV, INTERNAL_CALLER_TOKEN_ORDER_SERVICE: 'o'.repeat(32) })).toBeNull();
    expect(tokens.filter((name) => refusal({ ...BASE_ENV, [name]: 'a'.repeat(31) })?.includes(name))).toEqual(tokens);
  });

  it('bounds the relay, the retry ladder it stamps and the sweeps as the api does', () => {
    const cases: Array<[string, string, boolean]> = [
      ['QUEUE_PREFIX', '', false],
      ['QUEUE_CONSUMER_ATTEMPTS', '10', true],
      ['QUEUE_CONSUMER_ATTEMPTS', '11', false],
      ['QUEUE_CONSUMER_BACKOFF_MS', '99', false],
      ['ORDER_PAID_CONSUMER_ATTEMPTS', '30', true],
      ['ORDER_PAID_CONSUMER_ATTEMPTS', '31', false],
      ['OUTBOX_POLL_MS', '99', false],
      ['OUTBOX_BATCH_SIZE', '1001', false],
      ['OUTBOX_RELAY_ENABLED', '0', false],
      ['RECONCILE_INTERVAL_MS', '999', false],
      ['RECONCILE_BATCH_SIZE', '501', false],
      ['ORDER_STALE_THRESHOLD_SEC', '0', true],
      ['RETENTION_WEBHOOK_EVENT_DAYS', '13', false],
      ['RETENTION_WEBHOOK_EVENT_DAYS', '14', true],
      ['RETENTION_OUTBOX_DAYS', '0', false],
    ];

    const wrong = cases.filter(([key, value, valid]) => (refusal({ ...BASE_ENV, [key]: value }) === null) !== valid);

    expect(wrong).toEqual([]);
  });

  it('leaves the Stripe API address to the SDK when none is set', () => {
    for (const key of ['STRIPE_API_HOST', 'STRIPE_API_PORT', 'STRIPE_API_PROTOCOL']) vi.stubEnv(key, undefined);

    expect(configuration().payment.apiAddress).toBeUndefined();
  });

  it('reads a Stripe API address only as a whole host, with port and protocol optional', () => {
    vi.stubEnv('STRIPE_API_HOST', 'fake-stripe');
    vi.stubEnv('STRIPE_API_PORT', '12111');
    vi.stubEnv('STRIPE_API_PROTOCOL', 'http');

    expect(configuration().payment.apiAddress).toEqual({ host: 'fake-stripe', port: 12111, protocol: 'http' });

    vi.stubEnv('STRIPE_API_PORT', undefined);
    vi.stubEnv('STRIPE_API_PROTOCOL', undefined);
    expect(configuration().payment.apiAddress).toEqual({ host: 'fake-stripe' });
  });

  // A relay that disagrees with the order-service puts payment.authorized on another ladder than the
  // consumer expects, so the defaults are the order-service's.
  it("defaults the ladder it stamps on payment.authorized to the order-service's", () => {
    for (const key of [
      'QUEUE_PREFIX',
      'QUEUE_CONSUMER_ATTEMPTS',
      'QUEUE_CONSUMER_BACKOFF_MS',
      'ORDER_PAID_CONSUMER_ATTEMPTS',
    ]) {
      vi.stubEnv(key, undefined);
    }

    expect(configuration().queue).toEqual({
      prefix: 'bull',
      consumerAttempts: 8,
      consumerBackoffMs: 1000,
      orderPaidAttempts: 15,
    });
  });
});
