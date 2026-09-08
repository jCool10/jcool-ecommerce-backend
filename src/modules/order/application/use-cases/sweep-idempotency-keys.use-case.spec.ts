import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionSweepRegistry } from '@shared/retention';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import { SweepIdempotencyKeysUseCase } from './sweep-idempotency-keys.use-case';

const NOW = new Date('2026-09-07T12:00:00.000Z');

/** A sentinel, not `undefined` — that would collide with the default parameter below. */
const MISSING = Symbol('missing config');

function build(graceSec: unknown = 3600) {
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'retention.idempotencyGraceSec' || graceSec === MISSING) {
        throw new Error(`Missing config key: ${key}`);
      }
      return graceSec;
    },
  } as unknown as ConfigService;
  const store = { deleteExpired: vi.fn().mockResolvedValue(0) };
  const registry = new RetentionSweepRegistry();
  return {
    store,
    registry,
    make: () => new SweepIdempotencyKeysUseCase(store as unknown as IdempotencyStorePort, config, registry),
  };
}

/**
 * The predicate is the store's, proved against real SQL in `retention-sweep.e2e-spec.ts`; what is
 * this class's is the cutoff it hands down. A grace ADDED to now would collect keys that have not
 * expired yet, and each one of those is a retry of `POST /orders` turned into a second order.
 */
describe('SweepIdempotencyKeysUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers itself under its metric label', () => {
    const { make, registry } = build();

    make().onModuleInit();

    expect(registry.names()).toEqual(['order:idempotency-keys']);
  });

  it('moves the cutoff into the past, never into the future', async () => {
    const { make, store } = build(3600);

    await make().sweep(500);

    expect(store.deleteExpired).toHaveBeenCalledWith(new Date(NOW.getTime() - 3_600_000), 500);
  });

  it('sweeps on expiry alone with a zero grace', async () => {
    const { make, store } = build(0);

    await make().sweep(250);

    expect(store.deleteExpired).toHaveBeenCalledWith(NOW, 250);
  });

  it('refuses to build without its grace, rather than sweeping on a NaN cutoff', () => {
    expect(() => build(MISSING).make()).toThrow(/Missing config key/);
  });
});
