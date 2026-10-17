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
    'STRIPE_SUCCESS_URL',
    'ID_SERVICE_URL',
    'ID_SERVICE_TIMEOUT_MS',
    'MESSAGING_RETRY_ENABLED',
    'MESSAGING_RETRY_POLL_MS',
    'MESSAGING_RETRY_BATCH_SIZE',
    'MESSAGING_RETRY_LEASE_MS',
    'KAFKA_BROKERS',
    'KAFKA_CLIENT_ID',
    'KAFKA_PREFIX',
    'KAFKA_DELIVERY_TIMEOUT_MS',
    'MESSAGING_TRANSPORT',
    'MESSAGING_SIGNING_KEY',
  ]);

  it('publishes to BullMQ until the transport is switched, with no signing key of its own', () => {
    expect(configuration().messaging).toMatchObject({ transport: 'bullmq', signingKey: undefined });

    process.env.MESSAGING_TRANSPORT = 'kafka';
    process.env.MESSAGING_SIGNING_KEY = 'k'.repeat(32);
    expect(configuration().messaging).toMatchObject({ transport: 'kafka', signingKey: 'k'.repeat(32) });
  });

  it('knows no Kafka broker by default and names topics and groups under jcool', () => {
    expect(configuration().kafka).toEqual({
      brokers: [],
      clientId: 'jcool-api',
      prefix: 'jcool',
      deliveryTimeoutMs: 5_000,
    });
  });

  it('splits the broker list on commas and drops the blanks', () => {
    process.env.KAFKA_BROKERS = ' kafka:9092 , ,127.0.0.1:9094,';

    expect(configuration().kafka.brokers).toEqual(['kafka:9092', '127.0.0.1:9094']);
  });

  it('runs the consumer retry poller every second, 50 rows a tick, each leased for a minute', () => {
    expect(configuration().messaging.retry).toEqual({ enabled: true, pollMs: 1_000, batchSize: 50, leaseMs: 60_000 });
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
