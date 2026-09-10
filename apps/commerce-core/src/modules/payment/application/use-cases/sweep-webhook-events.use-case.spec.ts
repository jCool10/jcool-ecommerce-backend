import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionSweepRegistry } from '@shared/retention';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { SweepWebhookEventsUseCase } from './sweep-webhook-events.use-case';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');

/** A sentinel, not `undefined` — that would collide with the default parameter below. */
const MISSING = Symbol('missing config');

function build(days: unknown = 30) {
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'retention.webhookEventDays' || days === MISSING) throw new Error(`Missing config key: ${key}`);
      return days;
    },
  } as unknown as ConfigService;
  const webhookEvents = { deleteReceivedBefore: vi.fn().mockResolvedValue(0) };
  const registry = new RetentionSweepRegistry();
  return {
    webhookEvents,
    registry,
    make: () => new SweepWebhookEventsUseCase(webhookEvents as unknown as WebhookEventRepositoryPort, config, registry),
  };
}

describe('SweepWebhookEventsUseCase', () => {
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

    expect(registry.names()).toEqual(['payment:webhook-events']);
  });

  it('cuts off a whole window behind now', async () => {
    const { make, webhookEvents } = build(30);

    await make().sweep(500);

    expect(webhookEvents.deleteReceivedBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - 30 * DAY_MS), 500);
  });

  // Computed at construction, a process up for weeks would keep sweeping against the cutoff it
  // booted with and reclaim less and less as it aged.
  it('recomputes the cutoff on every tick', async () => {
    const { make, webhookEvents } = build(30);
    const sweep = make();

    await sweep.sweep(500);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));
    await sweep.sweep(500);

    const [first] = webhookEvents.deleteReceivedBefore.mock.calls[0] as [Date];
    const [second] = webhookEvents.deleteReceivedBefore.mock.calls[1] as [Date];
    expect(second.getTime() - first.getTime()).toBe(2 * DAY_MS);
  });

  it('refuses to build without its window', () => {
    expect(() => build(MISSING).make()).toThrow(/Missing config key/);
  });
});
