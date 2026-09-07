import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';

describe('configuration — database pool bounds', () => {
  const POOL_KEYS = ['DB_POOL_MAX', 'DB_POOL_CONNECTION_TIMEOUT_MS', 'DB_POOL_IDLE_TIMEOUT_MS'] as const;
  const saved = new Map<string, string | undefined>();

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    for (const key of POOL_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore so config keys don't leak into sibling specs sharing the process.
    for (const key of POOL_KEYS) restore(key, saved.get(key));
  });

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

  // Blank/whitespace must fall back to the bounded default, never NaN — a NaN timeout
  // is falsy to pg and silently reverts to wait-forever, defeating the bound.
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

describe('configuration — log identity stamped on every line', () => {
  const LOG_KEYS = [
    'LOG_SERVICE_NAME',
    'OTEL_SERVICE_NAME',
    'APP_VERSION',
    'RAILWAY_GIT_COMMIT_SHA',
    'LOG_SLOW_REQUEST_MS',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of LOG_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of LOG_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('names the service after OTEL_SERVICE_NAME so a log and a span share one label', () => {
    process.env.OTEL_SERVICE_NAME = 'jcool-api-staging';

    expect(configuration().log.service).toBe('jcool-api-staging');
  });

  it('lets LOG_SERVICE_NAME win over OTEL_SERVICE_NAME', () => {
    process.env.OTEL_SERVICE_NAME = 'from-otel';
    process.env.LOG_SERVICE_NAME = 'from-log';

    expect(configuration().log.service).toBe('from-log');
  });

  it('defaults the service name when neither is set', () => {
    expect(configuration().log.service).toBe('jcool-api');
  });

  // Which build emitted a line is the first question of any incident, so the fallback chain
  // matters: an explicit override, else the platform's commit SHA, else an honest 'dev'.
  it('prefers APP_VERSION over the platform commit SHA', () => {
    process.env.APP_VERSION = '1.4.2';
    process.env.RAILWAY_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

    expect(configuration().log.version).toBe('1.4.2');
  });

  it('falls back to a short commit SHA — full 40 chars on every line is waste', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

    expect(configuration().log.version).toBe('0123456789ab');
  });

  it("falls back to 'dev' off-platform", () => {
    expect(configuration().log.version).toBe('dev');
  });

  it('defaults the slow-request threshold to 1000ms', () => {
    expect(configuration().log.slowRequestMs).toBe(1000);
  });

  it('lets a deploy tune the slow-request threshold without a code change', () => {
    process.env.LOG_SLOW_REQUEST_MS = '250';

    expect(configuration().log.slowRequestMs).toBe(250);
  });

  // A blank var must not parse to NaN: `durationMs > NaN` is always false, which would switch the
  // slow flag off silently instead of failing loudly.
  it('treats a blank threshold as unset rather than NaN', () => {
    process.env.LOG_SLOW_REQUEST_MS = '  ';

    expect(configuration().log.slowRequestMs).toBe(1000);
  });
});
