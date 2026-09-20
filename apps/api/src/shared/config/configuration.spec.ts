import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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
    for (const key of keys) restore(key, saved.get(key));
  });
}

describe('configuration — database pool bounds', () => {
  const POOL_KEYS = ['DB_POOL_MAX', 'DB_POOL_CONNECTION_TIMEOUT_MS', 'DB_POOL_IDLE_TIMEOUT_MS'] as const;

  isolateEnv(POOL_KEYS);

  it('applies bounded defaults when the pool env is unset (finite connection timeout, not pg 0=forever)', () => {
    const { database } = configuration();

    expect(database.poolMax).toBe(10);
    expect(database.connectionTimeoutMs).toBe(5000);
    expect(database.idleTimeoutMs).toBe(10000);
  });

  it('honors env overrides', () => {
    process.env.DB_POOL_MAX = '40';
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = '2000';
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '30000';

    const { database } = configuration();

    expect(database.poolMax).toBe(40);
    expect(database.connectionTimeoutMs).toBe(2000);
    expect(database.idleTimeoutMs).toBe(30000);
  });

  it.each(['', '   '])('falls back to defaults for blank env (%j), never NaN', (blank) => {
    process.env.DB_POOL_MAX = blank;
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = blank;
    process.env.DB_POOL_IDLE_TIMEOUT_MS = blank;

    const { database } = configuration();

    expect(database.poolMax).toBe(10);
    expect(database.connectionTimeoutMs).toBe(5000);
    expect(database.idleTimeoutMs).toBe(10000);
  });
});

describe('configuration — optimistic reserve retry budget', () => {
  isolateEnv(['INVENTORY_OPTIMISTIC_MAX_RETRIES', 'INVENTORY_OPTIMISTIC_BACKOFF_MS']);

  it('defaults the retry budget when the env is unset', () => {
    expect(configuration().inventory.optimisticMaxRetries).toBe(3);
  });

  it.each(['', '   '])('falls back to the default for blank env (%j), never NaN', (blank) => {
    process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES = blank;

    // `attempt >= NaN` is always false, so a NaN budget would leave the CAS loop unbounded.
    expect(configuration().inventory.optimisticMaxRetries).toBe(3);
  });

  it('no longer exposes a backoff, so nothing can resurrect the removed retry sleep', () => {
    process.env.INVENTORY_OPTIMISTIC_BACKOFF_MS = '20';

    expect(configuration().inventory).not.toHaveProperty('optimisticBackoffMs');
  });
});

describe('configuration — Sentry', () => {
  isolateEnv(['SENTRY_TRACES_SAMPLE_RATE']);

  it('exposes no traces sample rate, a knob Sentry can no longer act on', () => {
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.5';

    // No Sentry span processor is attached, so a sample rate would only promise sampling that
    // cannot happen.
    expect(configuration().sentry).not.toHaveProperty('tracesSampleRate');
  });
});

describe('configuration — auth and user-directory modes', () => {
  isolateEnv([
    'AUTH_EPOCH_SOURCE',
    'USER_DIRECTORY_SOURCE',
    'AUTH_HS256_ENABLED',
    'AUTH_ROUTES_ENABLED',
    'RETENTION_AUTH_TOKENS_ENABLED',
    'AUTH_JWKS_URL',
    'USER_SERVICE_TIMEOUT_MS',
    'USER_DIRECTORY_NOT_FOUND_GRACE',
    'ORDER_PAID_CONSUMER_ATTEMPTS',
    'ORDER_PAID_CONSUMER_BACKOFF_CAP_MS',
  ]);

  it('keeps every flag on the behaviour that predates the user-service', () => {
    const config = configuration();

    expect(config.auth).toMatchObject({
      epochSource: 'db',
      hs256Enabled: true,
      routesEnabled: true,
      jwksUrl: undefined,
    });
    expect(config.userDirectory.source).toBe('local');
    expect(config.retention.authTokensEnabled).toBe(true);
  });

  it('reads the post-cutover modes', () => {
    Object.assign(process.env, {
      AUTH_EPOCH_SOURCE: 'redis',
      USER_DIRECTORY_SOURCE: 'remote',
      AUTH_HS256_ENABLED: 'false',
      AUTH_ROUTES_ENABLED: 'false',
      RETENTION_AUTH_TOKENS_ENABLED: 'false',
    });
    const config = configuration();

    expect(config.auth).toMatchObject({ epochSource: 'redis', hs256Enabled: false, routesEnabled: false });
    expect(config.userDirectory.source).toBe('remote');
    expect(config.retention.authTokensEnabled).toBe(false);
  });

  it('defaults the user-service call and the order.paid ladder', () => {
    const config = configuration();

    expect(config.userService.timeoutMs).toBe(500);
    expect(config.userDirectory.notFoundGrace).toBe('10m');
    expect(config.queue).toMatchObject({ orderPaidAttempts: 15, orderPaidBackoffCapMs: 300_000 });
  });
});

describe('configuration — Stripe success URL', () => {
  isolateEnv(['STRIPE_SUCCESS_URL']);

  it('leaves the success URL undefined when unset, so a live-key deploy fail-fasts at boot', () => {
    // A fabricated localhost default would satisfy the adapter's guard and silently redirect
    // real buyers to an unreachable host after they are charged.
    expect(configuration().payment.successUrl).toBeUndefined();
  });

  it('honors the env override', () => {
    process.env.STRIPE_SUCCESS_URL = 'https://shop.example.com/ok?session_id={CHECKOUT_SESSION_ID}';

    expect(configuration().payment.successUrl).toBe('https://shop.example.com/ok?session_id={CHECKOUT_SESSION_ID}');
  });
});
