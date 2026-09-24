import { describe, expect, it } from 'vitest';
import { EmptyEnv, validateEnv } from './validate-env';
import { ObservabilityEnv } from './observability.config';

const Env = ObservabilityEnv(EmptyEnv);

const rejects = (value: string): boolean => {
  try {
    validateEnv(Env, { LOKI_URL: value });
    return false;
  } catch (error) {
    return /LOKI_URL/.test((error as Error).message);
  }
};

describe('ObservabilityEnv LOKI_URL', () => {
  it('accepts a private-network host without a TLD', () => {
    expect(() => validateEnv(Env, { LOKI_URL: 'http://loki.railway.internal:3100' })).not.toThrow();
    expect(() => validateEnv(Env, { LOKI_URL: 'http://localhost:3100' })).not.toThrow();
  });

  // pino-loki resolves the push URL inside its own try block, so a bad one would fail every push
  // silently for the life of the process instead of failing the boot.
  it('rejects a blank value, a missing scheme and a non-http scheme', () => {
    const bad = ['', 'loki:3100', 'loki.railway.internal:3100', 'ftp://loki:3100'];

    expect(bad.filter((value) => !rejects(value))).toEqual([]);
  });
});
