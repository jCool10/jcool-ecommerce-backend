import { vi, type Mock } from 'vitest';
import type { MetricsPort } from '../observability/metrics/metrics.port';

/** A real `MetricsPort` to the code under test, a set of spies to the spec asserting on it. */
export type FakeMetricsPort = { [K in keyof MetricsPort]: Mock<MetricsPort[K]> };

/**
 * The port is wide and almost every spec fakes one method of it, so the hand-rolled version is
 * always `{ recordX: vi.fn() } as unknown as MetricsPort` — a cast that keeps compiling when the
 * code under test starts calling a second method, and then throws "not a function" at runtime.
 * Recording all of them costs nothing and removes the cast from the spec.
 */
const METHODS = [
  'observeCacheRebuild',
  'observeOrderValue',
  'observeRetentionSweepDuration',
  'recordAuthEvent',
  'recordBreakerCall',
  'recordBreakerTransition',
  'recordCartOperation',
  'recordCatalogCacheOperation',
  'recordCompensation',
  'recordConsumeRetry',
  'recordDeadLetter',
  'recordEventConsumed',
  'recordEventPublished',
  'recordMailSendFailure',
  'recordMediaBytesReclaimed',
  'recordOrderCreated',
  'recordRateLimitRejection',
  'recordRefundOwed',
  'recordReservationExpiry',
  'recordRetentionSweep',
  'recordRetentionSweepFailure',
  'recordSagaStep',
  'setBreakerState',
] as const satisfies readonly (keyof MetricsPort)[];

/**
 * `satisfies readonly (keyof MetricsPort)[]` only checks that each entry IS a key — it does not
 * require covering the union, and the cast in `fakeMetricsPort` erases the gap. So a 24th method on
 * the port would compile clean, be omitted from the fake, and produce exactly the "not a function"
 * the docblock above claims to have removed. This line is the missing half: it resolves to `never`
 * the moment a key is added to `MetricsPort` without being added to `METHODS`, and assigning `true`
 * to `never` fails the build.
 */
const _everyMethodIsFaked: Exclude<keyof MetricsPort, (typeof METHODS)[number]> extends never ? true : never = true;
void _everyMethodIsFaked;

/** `overrides` is for the spec that already holds a named spy it asserts on. */
export function fakeMetricsPort(overrides: Partial<MetricsPort> = {}): FakeMetricsPort {
  return {
    ...Object.fromEntries(METHODS.map((name) => [name, vi.fn()])),
    ...overrides,
  } as unknown as FakeMetricsPort;
}
