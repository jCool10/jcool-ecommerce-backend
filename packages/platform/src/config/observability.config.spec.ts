import { describe, expect, it } from 'vitest';
import { EmptyEnv, validateEnv } from './validate-env';
import { ObservabilityEnv } from './observability.config';

const Env = ObservabilityEnv(EmptyEnv);

const rejectsAs = (name: string, value: string): boolean => {
  try {
    validateEnv(Env, { [name]: value });
    return false;
  } catch (error) {
    return new RegExp(name).test((error as Error).message);
  }
};
const rejects = (value: string): boolean => rejectsAs('LOKI_URL', value);

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

// The SDK falls back to sampling everything on a name or ratio it cannot read, and says so only
// through a diag logger, so a typo would silently undo a lowered ratio or the ratio-0 off switch.
describe('ObservabilityEnv trace sampler', () => {
  it('accepts the sampler names the SDK knows', () => {
    for (const sampler of [
      'always_on',
      'always_off',
      'traceidratio',
      'parentbased_always_on',
      'parentbased_always_off',
      'parentbased_traceidratio',
    ]) {
      expect(() => validateEnv(Env, { OTEL_TRACES_SAMPLER: sampler }), sampler).not.toThrow();
    }
  });

  it('rejects an unknown or blank sampler name', () => {
    const bad = ['', 'parentbased_ratio', 'PARENTBASED_TRACEIDRATIO', 'jaeger_remote'];

    expect(bad.filter((value) => !rejectsAs('OTEL_TRACES_SAMPLER', value))).toEqual([]);
  });

  it('accepts a ratio from 0 to 1', () => {
    for (const ratio of ['0', '0.25', '0.1', '1', '1.0']) {
      expect(() => validateEnv(Env, { OTEL_TRACES_SAMPLER_ARG: ratio }), ratio).not.toThrow();
    }
  });

  it('rejects a ratio outside 0 to 1 or not written as a plain decimal', () => {
    const bad = ['', '-0.1', '1.5', '2', '10%', 'abc', '1e-1', '.5', ' 0.5'];

    expect(bad.filter((value) => !rejectsAs('OTEL_TRACES_SAMPLER_ARG', value))).toEqual([]);
  });
});
