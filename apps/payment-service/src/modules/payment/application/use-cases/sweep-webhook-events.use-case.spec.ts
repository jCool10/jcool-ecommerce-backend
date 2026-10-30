import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { SweepWebhookEventsUseCase } from './sweep-webhook-events.use-case';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');

describe('SweepWebhookEventsUseCase', () => {
  useFakeClock(NOW);

  // Computed at construction, a process up for weeks would keep sweeping against the cutoff it
  // booted with and reclaim less and less as it aged.
  it('recomputes the cutoff on every tick', async () => {
    const webhookEvents = { deleteReceivedBefore: vi.fn().mockResolvedValue(0) };
    const sweep = new SweepWebhookEventsUseCase(
      webhookEvents as unknown as WebhookEventRepositoryPort,
      fakeConfigService({ 'retention.webhookEventDays': 30 }),
      new RetentionSweepRegistry(),
    );

    await sweep.sweep(500);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));
    await sweep.sweep(500);

    expect(webhookEvents.deleteReceivedBefore.mock.calls).toEqual([
      [new Date(NOW.getTime() - 30 * DAY_MS), 500],
      [new Date(NOW.getTime() - 28 * DAY_MS), 500],
    ]);
  });
});
