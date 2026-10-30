import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_SAGA_DEFAULTS } from './checkout-saga.config';
import { CROSS_RULE_FOREIGN_DEFAULTS } from './checkout-saga.env';
import configuration from './configuration';

// Clears the given keys before each test and puts them back after, so config keys never leak
// into sibling specs sharing the process.
function isolateEnv(keys: readonly string[]): void {
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
}

describe('configuration', () => {
  isolateEnv([
    'ID_SERVICE_URL',
    'ID_SERVICE_TIMEOUT_MS',
    'API_SERVICE_URL',
    'API_SERVICE_TOKEN',
    'API_SERVICE_TIMEOUT_MS',
    'INVENTORY_SERVICE_URL',
    'INVENTORY_SERVICE_TOKEN',
    'INVENTORY_COMMAND_TIMEOUT_MS',
    'PAYMENT_SERVICE_URL',
    'PAYMENT_SERVICE_TOKEN',
    'PAYMENT_COMMAND_TIMEOUT_MS',
    'USER_SERVICE_URL',
    'USER_SERVICE_TOKEN',
    'USER_SERVICE_TIMEOUT_MS',
    'USER_DIRECTORY_NOT_FOUND_GRACE',
  ]);

  it('reads the id-service address and gives the call the gateway retries 2s by default', () => {
    process.env.ID_SERVICE_URL = 'http://gateway:4000';

    expect(configuration().idService).toEqual({ url: 'http://gateway:4000', timeoutMs: 2_000 });
  });

  it('reads the api address and token, and gives a cart or catalog read 2s by default', () => {
    process.env.API_SERVICE_URL = 'http://api:8080';
    process.env.API_SERVICE_TOKEN = 'a-token';

    expect(configuration().apiService).toEqual({ url: 'http://api:8080', token: 'a-token', timeoutMs: 2_000 });
  });

  it('reads the inventory-service address and token, and gives a command 5s by default', () => {
    process.env.INVENTORY_SERVICE_URL = 'http://inventory-service:3000';
    process.env.INVENTORY_SERVICE_TOKEN = 'a-token';

    expect(configuration().inventoryService).toEqual({
      url: 'http://inventory-service:3000',
      token: 'a-token',
      commandTimeoutMs: 5_000,
    });
  });

  it('reads the payment-service address and token, and gives a command 45s by default', () => {
    process.env.PAYMENT_SERVICE_URL = 'http://payment-service:3000';
    process.env.PAYMENT_SERVICE_TOKEN = 'a-token';

    expect(configuration().paymentService).toEqual({
      url: 'http://payment-service:3000',
      token: 'a-token',
      commandTimeoutMs: 45_000,
    });
  });

  it('maps its user-service credentials onto the keys the shared client reads', () => {
    process.env.USER_SERVICE_URL = 'http://user-service:3000';
    process.env.USER_SERVICE_TOKEN = 'token';

    expect(configuration().userService).toEqual({ url: 'http://user-service:3000', token: 'token', timeoutMs: 500 });
    expect(configuration().userDirectory).toEqual({ notFoundGrace: '10m' });
  });
});

describe('configuration: checkout saga', () => {
  isolateEnv([
    ...Object.keys(CHECKOUT_SAGA_DEFAULTS),
    ...Object.keys(CROSS_RULE_FOREIGN_DEFAULTS),
    'TEMPORAL_ADDRESS',
    'CHECKOUT_INVARIANT_ENABLED',
    'CHECKOUT_INVARIANT_NOT_BEFORE',
  ]);

  it('sizes the pool for the saga worker at 16 by default, and lets DB_POOL_MAX win', () => {
    expect(configuration().database.poolMax).toBe(16);

    process.env.DB_POOL_MAX = '7';
    expect(configuration().database.poolMax).toBe(7);
  });

  it('loads every saga default env validation assumes', () => {
    const saga = configuration().checkoutSaga;

    expect(saga).toMatchObject({
      paymentDeadlineSec: CHECKOUT_SAGA_DEFAULTS.CHECKOUT_PAYMENT_DEADLINE_SEC,
      payCutoffSec: CHECKOUT_SAGA_DEFAULTS.CHECKOUT_PAY_CUTOFF_SEC,
      tryTimeoutMs: 3000,
      reserveWaitMs: 6000,
      retryAfterSec: 5,
      activityConcurrency: 2,
      localActivityConcurrency: 2,
      temporal: { address: 'localhost:7233', namespace: 'jcool', taskQueue: 'checkout-saga', workerEnabled: true },
      overdueGraceSec: 300,
      invariant: {
        enabled: true,
        intervalMs: 60_000,
        settleSec: 600,
        windowSec: 86_400,
        batchSize: 200,
        notBefore: null,
      },
    });
  });

  it('reads the checker cut-off as an instant, and turns the checker off only on an explicit false', () => {
    process.env.CHECKOUT_INVARIANT_NOT_BEFORE = '2026-10-24T10:00:00+07:00';
    process.env.CHECKOUT_INVARIANT_ENABLED = 'false';

    expect(configuration().checkoutSaga.invariant).toMatchObject({
      enabled: false,
      notBefore: new Date('2026-10-24T03:00:00.000Z'),
    });
  });

  // The cross rules resolve an unset var to these; drifting from what loads would validate one
  // config and run another.
  it('mirrors the foreign defaults the cross rules resolve to', () => {
    const config = configuration();

    expect({
      PAYMENT_COMMAND_TIMEOUT_MS: config.paymentService.commandTimeoutMs,
      INVENTORY_COMMAND_TIMEOUT_MS: config.inventoryService.commandTimeoutMs,
      API_SERVICE_TIMEOUT_MS: config.apiService.timeoutMs,
      QUEUE_WORKER_CONCURRENCY: config.queue.workerConcurrency,
      DB_POOL_MAX: config.database.poolMax,
    }).toEqual(CROSS_RULE_FOREIGN_DEFAULTS);
  });
});
