import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import { SweepPublishedOutbox } from './sweep-published-outbox';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');

describe('SweepPublishedOutbox', () => {
  useFakeClock(NOW);

  // A window added to now would collect rows the relay published moments ago.
  it('cuts off one retention window before the current time', () => {
    const config = fakeConfigService({ 'retention.outboxDays': 30 });
    const sweep = new SweepPublishedOutbox({} as DrizzleDB, config, new RetentionSweepRegistry());

    const first = sweep.cutoff();
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));

    expect([first, sweep.cutoff()]).toEqual([
      new Date(NOW.getTime() - 30 * DAY_MS),
      new Date(NOW.getTime() - 28 * DAY_MS),
    ]);
  });
});
