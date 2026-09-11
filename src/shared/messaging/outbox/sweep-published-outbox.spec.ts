import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { useFakeClock } from '@shared/testing/fake-clock';
import { RetentionSweepRegistry } from '@shared/retention';
import { SweepPublishedOutbox } from './sweep-published-outbox';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');

/** A sentinel, not `undefined` — that would collide with the default parameter below. */
const MISSING = Symbol('missing config');

function build(days: unknown = 30) {
  const config = fakeConfigService(days === MISSING ? {} : { 'retention.outboxDays': days });
  const registry = new RetentionSweepRegistry();
  return {
    registry,
    make: () => new SweepPublishedOutbox({} as DrizzleDB, config, registry),
  };
}

// The predicate is proved against real rows in `retention-sweep.e2e-spec.ts`. What is worth
// asserting without a database is the cutoff's direction: a window ADDED to now would collect rows
// the relay published moments ago.
describe('SweepPublishedOutbox', () => {
  useFakeClock(NOW);

  it('registers itself, so a table is never left uncollected by a forgotten wiring line', () => {
    const { make, registry } = build();

    make().onModuleInit();

    expect(registry.names()).toEqual(['messaging:outbox']);
  });

  // A missing key would become NaN days, and `lt(published_at, Invalid Date)` matches nothing — a
  // sweep that runs forever, reports success, and reclaims not one row.
  it('refuses to build without its window, rather than sweeping on a NaN cutoff', () => {
    expect(() => build(MISSING).make()).toThrow(/Missing config key/);
  });

  it('registers under the same label the metrics and the runbook name it by', () => {
    expect(build().make().name).toBe('messaging:outbox');
  });

  it('sweeps without throwing when the batch comes back empty', async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => 'subquery' }) }) }),
      delete: () => ({ where: () => ({ returning }) }),
    } as unknown as DrizzleDB;
    const config = fakeConfigService({ 'retention.outboxDays': 30 });

    const sweep = new SweepPublishedOutbox(db, config, new RetentionSweepRegistry());

    await expect(sweep.sweep(500)).resolves.toBe(0);
  });

  it('reports the row count the delete actually returned, not the batch size it asked for', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const limit = vi.fn().mockReturnValue('subquery');
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      delete: () => ({ where: () => ({ returning }) }),
    } as unknown as DrizzleDB;
    const config = fakeConfigService({ 'retention.outboxDays': 30 });

    const deleted = await new SweepPublishedOutbox(db, config, new RetentionSweepRegistry()).sweep(500);

    // The scheduler compares this against the batch size to detect a backlog, so returning the cap
    // instead of the count would raise that warning on every idle tick.
    expect(deleted).toBe(3);
    expect(limit).toHaveBeenCalledWith(500);
  });

  // Computed at construction, a process up for weeks would keep sweeping against the cutoff it
  // booted with and reclaim less and less as it aged.
  it('recomputes the cutoff on every tick', async () => {
    const where = vi.fn().mockReturnValue({ limit: () => 'subquery' });
    const db = {
      select: () => ({ from: () => ({ where }) }),
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as DrizzleDB;
    const config = fakeConfigService({ 'retention.outboxDays': 30 });
    const sweep = new SweepPublishedOutbox(db, config, new RetentionSweepRegistry());

    await sweep.sweep(500);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));
    await sweep.sweep(500);

    expect(where).toHaveBeenCalledTimes(2);
    expect(where.mock.calls[0]).not.toEqual(where.mock.calls[1]);
  });
});
