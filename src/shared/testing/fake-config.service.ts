import type { ConfigService } from '@nestjs/config';

/**
 * A `ConfigService` that answers from one map.
 *
 * `getOrThrow` throwing for an absent key is the half that matters: several services are supposed to
 * refuse to boot without theirs, and a double that answers every key — `{ getOrThrow: () => value }`
 * — would let that regression through. A key mapped to `undefined` counts as absent, which is how a
 * spec stages "the operator never set it".
 */
export function fakeConfigService(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`Missing config key: ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}
