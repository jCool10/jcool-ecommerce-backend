import { afterEach, describe, expect, it } from 'vitest';
import { EmptyEnv, validateEnv } from './validate-env';
import { observabilityConfig, ObservabilityEnv } from './observability.config';

const Env = ObservabilityEnv(EmptyEnv);

describe('observabilityConfig — Loki', () => {
  const saved = process.env.LOKI_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.LOKI_URL;
    else process.env.LOKI_URL = saved;
  });

  it('ships nowhere when LOKI_URL is unset', () => {
    delete process.env.LOKI_URL;

    expect(observabilityConfig({ serviceName: 'svc' }).loki.url).toBeUndefined();
  });

  it('reads LOKI_URL', () => {
    process.env.LOKI_URL = 'http://loki.railway.internal:3100';

    expect(observabilityConfig({ serviceName: 'svc' }).loki.url).toBe('http://loki.railway.internal:3100');
  });
});

describe('ObservabilityEnv — LOKI_URL', () => {
  it('is optional', () => {
    expect(() => validateEnv(Env, {})).not.toThrow();
  });

  it('accepts a private-network host without a TLD', () => {
    expect(() => validateEnv(Env, { LOKI_URL: 'http://loki.railway.internal:3100' })).not.toThrow();
    expect(() => validateEnv(Env, { LOKI_URL: 'http://localhost:3100' })).not.toThrow();
  });

  // pino-loki resolves the push URL inside its own try block, so a bad one would fail every push
  // silently for the life of the process instead of failing the boot.
  it.each(['', 'loki:3100', 'loki.railway.internal:3100', 'ftp://loki:3100'])('rejects %j', (value) => {
    expect(() => validateEnv(Env, { LOKI_URL: value })).toThrow(/LOKI_URL/);
  });
});
