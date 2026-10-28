import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

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
};

const PRODUCTION_ENV = {
  ...BASE_ENV,
  NODE_ENV: NodeEnv.Production,
  TRUST_PROXY: 'false',
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key_0000',
  STRIPE_SUCCESS_URL: 'https://shop.example.test/payments/success?session_id={CHECKOUT_SESSION_ID}',
  TEMPORAL_ADDRESS: 'temporal.railway.internal:7233',
  TEMPORAL_NAMESPACE: 'jcool',
  TEMPORAL_TASK_QUEUE: 'checkout-saga',
};

// What the saga e2e suites run with: every wait shrunk to seconds, still inside every cross rule.
const SHORT_ENV = {
  ...BASE_ENV,
  CHECKOUT_PAYMENT_DEADLINE_SEC: '6',
  CHECKOUT_PAY_CUTOFF_SEC: '2',
  CHECKOUT_HOLD_SAFETY_SEC: '10',
  CHECKOUT_TRY_TIMEOUT_MS: '1000',
  CHECKOUT_RESERVE_WAIT_MS: '3000',
  CHECKOUT_CANCEL_WAIT_MS: '3000',
  CHECKOUT_RESERVING_ORPHAN_SEC: '4',
  INVENTORY_COMMAND_TIMEOUT_MS: '2000',
  SAGA_AUTH_GRACE_SEC: '1',
  SAGA_ACTIVITY_TIMEOUT_MS: '8000',
  SAGA_RETRY_BASE_MS: '100',
  SAGA_RETRY_CAP_MS: '1000',
  PAYMENT_CAPTURE_TIMEOUT_MS: '500',
  PAYMENT_SESSION_MIN_TTL_SEC: '0',
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
};

const expectValid = (env: Record<string, unknown>, label?: string) => expect(() => validate(env), label).not.toThrow();
const expectInvalid = (env: Record<string, unknown>, message: RegExp) => expect(() => validate(env)).toThrow(message);

describe('checkout saga env', () => {
  it('boots on the defaults, in test and in production', () => {
    expectValid(BASE_ENV);
    expectValid(PRODUCTION_ENV);
  });

  it('accepts the shortened config the saga suites run with', () => {
    expectValid(SHORT_ENV);
  });

  it('bounds each variable on its own', () => {
    const cases: Array<[string, string, boolean]> = [
      ['CHECKOUT_PAYMENT_DEADLINE_SEC', '4', false],
      ['CHECKOUT_PAY_CUTOFF_SEC', '-1', false],
      ['CHECKOUT_HOLD_SAFETY_SEC', '9', false],
      ['CHECKOUT_TRY_TIMEOUT_MS', '499', false],
      ['CHECKOUT_RESERVE_WAIT_MS', '999', false],
      ['CHECKOUT_CANCEL_WAIT_MS', '999', false],
      ['CHECKOUT_CANCEL_WAIT_MS', '1000', true],
      ['CHECKOUT_REAPER_ENABLED', '0', false],
      ['CHECKOUT_REAPER_ENABLED', 'false', true],
      ['CHECKOUT_REAPER_INTERVAL_MS', '999', false],
      ['CHECKOUT_REAPER_INTERVAL_MS', '1000', true],
      ['CHECKOUT_RESERVING_ORPHAN_SEC', '0', false],
      ['CHECKOUT_RETRY_AFTER_SEC', '0', false],
      ['CHECKOUT_RETRY_AFTER_SEC', '1', true],
      ['SAGA_AUTH_GRACE_SEC', '-1', false],
      ['SAGA_AUTH_GRACE_SEC', '0', true],
      ['SAGA_ACTIVITY_TIMEOUT_MS', '999', false],
      ['SAGA_ACTIVITY_CONCURRENCY', '0', false],
      ['SAGA_ACTIVITY_CONCURRENCY', '21', false],
      ['SAGA_LOCAL_ACTIVITY_CONCURRENCY', '0', false],
      ['SAGA_LOCAL_ACTIVITY_CONCURRENCY', '21', false],
      ['SAGA_RETRY_BASE_MS', '99', false],
      ['SAGA_RETRY_CAP_MS', '999', false],
      ['TEMPORAL_WORKER_ENABLED', '1', false],
      ['TEMPORAL_WORKER_ENABLED', 'false', true],
      ['TEMPORAL_WORKER_SHUTDOWN_GRACE_MS', '-1', false],
      ['TEMPORAL_WORKER_SHUTDOWN_GRACE_MS', '0', true],
      ['TEMPORAL_WORKER_SHUTDOWN_FORCE_MS', '-1', false],
      ['TEMPORAL_WORKER_SHUTDOWN_FORCE_MS', '0', true],
      ['TEMPORAL_NAMESPACE', '', false],
      ['TEMPORAL_TASK_QUEUE', '', false],
      ['TEMPORAL_WORKFLOW_BUNDLE_PATH', '', false],
      ['TEMPORAL_WORKFLOW_BUNDLE_PATH', '/tmp/checkout-saga.bundle.js', true],
      ['SAGA_ACTIVITY_TIMEOUT_MS', '6e4', false],
      ['SAGA_OVERDUE_GRACE_SEC', '0', false],
      ['CHECKOUT_INVARIANT_ENABLED', '0', false],
      ['CHECKOUT_INVARIANT_ENABLED', 'false', true],
      ['CHECKOUT_INVARIANT_INTERVAL_MS', '999', false],
      ['CHECKOUT_INVARIANT_INTERVAL_MS', '1000', true],
      ['CHECKOUT_INVARIANT_SETTLE_SEC', '-1', false],
      ['CHECKOUT_INVARIANT_SETTLE_SEC', '0', true],
      ['CHECKOUT_INVARIANT_BATCH_SIZE', '0', false],
      ['CHECKOUT_INVARIANT_BATCH_SIZE', '200', true],
      ['CHECKOUT_INVARIANT_BATCH_SIZE', '201', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-10-24T03:00:00Z', true],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-10-24T10:00:00.250+07:00', true],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-10-24', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-10-24T03:00:00', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-W43-5T03:00:00Z', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-13-40T03:00:00Z', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '2026-02-30T03:00:00Z', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', '', false],
      ['CHECKOUT_INVARIANT_NOT_BEFORE', 'yesterday', false],
    ];
    for (const [key, value, valid] of cases) {
      const env = { ...BASE_ENV, [key]: value };
      if (valid) expectValid(env, `${key}=${value}`);
      else expect(() => validate(env), `${key}=${value}`).toThrow(new RegExp(key));
    }
  });

  it('takes a host:port Temporal address and nothing else', () => {
    for (const address of ['localhost:7233', 'temporal:7233', 'temporal.railway.internal:7233', '[fd12::1]:7233']) {
      expectValid({ ...BASE_ENV, TEMPORAL_ADDRESS: address }, address);
    }
    for (const address of ['temporal', 'http://temporal:7233', 'temporal:', ':7233', 'temporal:72330']) {
      expect(() => validate({ ...BASE_ENV, TEMPORAL_ADDRESS: address }), address).toThrow(/TEMPORAL_ADDRESS/);
    }
  });

  it('refuses to boot in production without an explicit Temporal address, namespace and task queue', () => {
    for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_TASK_QUEUE']) {
      const without: Record<string, unknown> = { ...PRODUCTION_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(`${key}: required in production`));
    }
  });

  describe('cross rules', () => {
    it('keeps a saga activity alive past every capture attempt the participant may make', () => {
      expectInvalid(
        { ...BASE_ENV, SAGA_ACTIVITY_TIMEOUT_MS: '45000' },
        /SAGA_ACTIVITY_TIMEOUT_MS \(45000\) must exceed 4 × PAYMENT_CAPTURE_TIMEOUT_MS \(10000\) \+ 5000/,
      );
      expectValid({ ...BASE_ENV, SAGA_ACTIVITY_TIMEOUT_MS: '45001' });
    });

    it('keeps a saga activity alive past the breaker and the breaker-guarded capture', () => {
      expectInvalid(
        { ...BASE_ENV, ...SHORT_ENV, BREAKER_TIMEOUT_MS: '8000' },
        /SAGA_ACTIVITY_TIMEOUT_MS \(8000\) must exceed max\(BREAKER_TIMEOUT_MS \(8000\), 2 × PAYMENT_CAPTURE_TIMEOUT_MS \(500\) \+ 1000\)/,
      );
      expectValid({ ...BASE_ENV, ...SHORT_ENV, BREAKER_TIMEOUT_MS: '7999' });
    });

    it('keeps a saga activity alive past an inventory command and five seconds', () => {
      expectInvalid(
        { ...BASE_ENV, ...SHORT_ENV, INVENTORY_COMMAND_TIMEOUT_MS: '3000' },
        /SAGA_ACTIVITY_TIMEOUT_MS \(8000\) must exceed INVENTORY_COMMAND_TIMEOUT_MS \(3000\) \+ 5000/,
      );
      expectValid({ ...BASE_ENV, ...SHORT_ENV, INVENTORY_COMMAND_TIMEOUT_MS: '2999' });
    });

    it('waits on reserve for the whole Try plus two seconds', () => {
      expectInvalid(
        { ...BASE_ENV, CHECKOUT_RESERVE_WAIT_MS: '4999' },
        /CHECKOUT_RESERVE_WAIT_MS \(4999\) must be at least CHECKOUT_TRY_TIMEOUT_MS \(3000\) \+ 2000/,
      );
      expectValid({ ...BASE_ENV, CHECKOUT_RESERVE_WAIT_MS: '5000' });
    });

    it('treats an order as orphaned only after reserve has stopped waiting', () => {
      expectInvalid(
        { ...BASE_ENV, CHECKOUT_RESERVING_ORPHAN_SEC: '6' },
        /CHECKOUT_RESERVING_ORPHAN_SEC \(6\) × 1000 must exceed CHECKOUT_RESERVE_WAIT_MS \(6000\)/,
      );
    });

    // A run waiting out its grace must not read as overdue.
    it('ends the authorization grace before a saga counts as overdue', () => {
      expectInvalid(
        { ...BASE_ENV, SAGA_OVERDUE_GRACE_SEC: '180' },
        /SAGA_AUTH_GRACE_SEC \(180\) must be below SAGA_OVERDUE_GRACE_SEC \(180\)/,
      );
      expectValid({ ...BASE_ENV, SAGA_OVERDUE_GRACE_SEC: '181' });
    });

    it('scans a window wider than the settle delay it leaves out', () => {
      expectInvalid(
        { ...BASE_ENV, CHECKOUT_INVARIANT_WINDOW_SEC: '600' },
        /CHECKOUT_INVARIANT_WINDOW_SEC \(600\) must exceed CHECKOUT_INVARIANT_SETTLE_SEC \(600\)/,
      );
      expectValid({ ...BASE_ENV, CHECKOUT_INVARIANT_SETTLE_SEC: '0', CHECKOUT_INVARIANT_WINDOW_SEC: '1' });
    });

    it('ends the authorization grace before the stock hold', () => {
      expectInvalid(
        { ...BASE_ENV, SAGA_AUTH_GRACE_SEC: '3600' },
        /SAGA_AUTH_GRACE_SEC \(3600\) must be below CHECKOUT_HOLD_SAFETY_SEC \(3600\)/,
      );
    });

    it('never lets the retry cap undercut the base', () => {
      expectInvalid(
        { ...BASE_ENV, SAGA_RETRY_BASE_MS: '2000', SAGA_RETRY_CAP_MS: '1000' },
        /SAGA_RETRY_CAP_MS \(1000\) must be at least SAGA_RETRY_BASE_MS \(2000\)/,
      );
    });

    it('closes payment before the deadline', () => {
      expectInvalid(
        { ...BASE_ENV, CHECKOUT_PAYMENT_DEADLINE_SEC: '1980' },
        /CHECKOUT_PAYMENT_DEADLINE_SEC \(1980\) must exceed CHECKOUT_PAY_CUTOFF_SEC \(1980\)/,
      );
    });

    // The extra minute is the buyer's time to act on the session; suites with a 6s deadline go without it.
    it('leaves room for the shortest payment session, with a minute more in production', () => {
      expectInvalid(
        { ...PRODUCTION_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1979' },
        /CHECKOUT_PAY_CUTOFF_SEC \(1979\) must be at least PAYMENT_SESSION_MIN_TTL_SEC \(1800\) \+ PAYMENT_SESSION_EXPIRY_MARGIN_SEC \(120\) \+ 60/,
      );
      expectValid({ ...PRODUCTION_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1980' });
      expectValid({ ...BASE_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1920' });
      expectInvalid({ ...BASE_ENV, CHECKOUT_PAY_CUTOFF_SEC: '1919' }, /CHECKOUT_PAY_CUTOFF_SEC \(1919\)/);
    });

    it('keeps five pool connections spare beyond the queue worker and both saga pools', () => {
      expectValid({ ...BASE_ENV, DB_POOL_MAX: '14' });
      expectInvalid(
        { ...BASE_ENV, DB_POOL_MAX: '13' },
        /QUEUE_WORKER_CONCURRENCY \(5\) \+ SAGA_ACTIVITY_CONCURRENCY \(2\) \+ SAGA_LOCAL_ACTIVITY_CONCURRENCY \(2\) \+ 5 must not exceed DB_POOL_MAX \(13\)/,
      );
      expectInvalid({ ...BASE_ENV, SAGA_ACTIVITY_CONCURRENCY: '9' }, /DB_POOL_MAX \(20\)/);
    });
  });
});
