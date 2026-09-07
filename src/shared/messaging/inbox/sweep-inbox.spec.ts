import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database';
import { RetentionSweepRegistry } from '@shared/retention';
import { MIN_INBOX_RETENTION_DAYS } from '../queue/queue.constants';
import { SweepInbox } from './sweep-inbox';

const MINIMUM_DAYS = MIN_INBOX_RETENTION_DAYS;

function build(days: unknown) {
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'retention.inboxDays') throw new Error(`Missing config key: ${key}`);
      return days;
    },
  } as unknown as ConfigService;
  const registry = new RetentionSweepRegistry();
  return {
    registry,
    make: () => new SweepInbox({} as DrizzleDB, config, registry),
  };
}

/**
 * The predicate is proved against real rows in `retention-sweep.e2e-spec.ts`. What is worth
 * asserting without a database is the boot guard, since the config it rejects fails nowhere else —
 * it produces a correct-looking app that has quietly lost exactly-once delivery.
 */
describe('SweepInbox', () => {
  it('registers itself, so a table is never left uncollected by a forgotten wiring line', () => {
    const { make, registry } = build(30);

    make().onModuleInit();

    expect(registry.names()).toEqual(['messaging:inbox']);
  });

  it('refuses to boot on a window shorter than the queue can still redeliver in', () => {
    const { make } = build(MINIMUM_DAYS - 1);

    expect(() => make()).toThrow(/effect a second time/);
    expect(() => make()).toThrow(new RegExp(`at least ${MINIMUM_DAYS} days`));
  });

  it('accepts a window that exactly clears the failed-job horizon', () => {
    expect(() => build(MINIMUM_DAYS).make()).not.toThrow();
  });

  // A missing key would otherwise become NaN days, and `lt(processed_at, Invalid Date)` matches
  // nothing — a sweep that runs forever, reports success, and reclaims not one row.
  it('refuses to boot without the key at all', () => {
    const config = {
      getOrThrow: (key: string) => {
        throw new Error(`Missing config key: ${key}`);
      },
    } as unknown as ConfigService;

    expect(() => new SweepInbox({} as DrizzleDB, config, new RetentionSweepRegistry())).toThrow(/Missing config key/);
  });
});
