import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    'INVENTORY_OPTIMISTIC_MAX_RETRIES',
    'INVENTORY_TRY_LOCK_TIMEOUT_MS',
    'INVENTORY_HOLD_SWEEP_ENABLED',
    'INVENTORY_HOLD_SWEEP_INTERVAL_MS',
    'INVENTORY_HOLD_SWEEP_BATCH_SIZE',
    'STRIPE_SUCCESS_URL',
    'ID_SERVICE_URL',
    'ID_SERVICE_TIMEOUT_MS',
  ]);

  it('runs the lapsed hold sweep and bounds a Try at 2s unless told otherwise', () => {
    const { tryLockTimeoutMs, holdSweep } = configuration().inventory;

    expect(tryLockTimeoutMs).toBe(2_000);
    expect(holdSweep).toEqual({ enabled: true, intervalMs: 60_000, batchSize: 50 });
  });

  it('reads the id-service address and gives the call the gateway retries 2s by default', () => {
    process.env.ID_SERVICE_URL = 'http://gateway:4000';

    expect(configuration().idService).toEqual({ url: 'http://gateway:4000', timeoutMs: 2_000 });
  });

  // `attempt >= NaN` is always false, so a NaN budget would leave the CAS loop unbounded.
  it('falls back to the default reserve retry budget for a blank env value', () => {
    const budgets = ['', '   '].map((blank) => {
      process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES = blank;
      return configuration().inventory.optimisticMaxRetries;
    });

    expect(budgets).toEqual([3, 3]);
  });

  // A localhost default would pass the adapter's live-key guard and send charged buyers nowhere.
  it('leaves the Stripe success URL undefined when unset', () => {
    expect(configuration().payment.successUrl).toBeUndefined();
  });
});
