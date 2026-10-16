import { describe, expect, it, vi } from 'vitest';
import {
  parseRepublishArgs,
  parseSince,
  republishOutbox,
  type OutboxWindowStore,
  type RepublishRetention,
} from './republish-outbox';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const RETENTION: RepublishRetention = { inboxDays: 30, outboxDays: 30 };

function storeWith(overrides: Partial<OutboxWindowStore> = {}) {
  return {
    countByEventType: vi.fn().mockResolvedValue([{ eventType: 'order.paid', rows: 3 }]),
    countClaimsByConsumer: vi.fn().mockResolvedValue([{ consumer: 'domain-events', rows: 2 }]),
    resetPublished: vi.fn().mockResolvedValue(3),
    ...overrides,
  } satisfies OutboxWindowStore;
}

describe('parseSince', () => {
  it('reads minutes, hours and days', () => {
    expect([parseSince('90m'), parseSince('6h'), parseSince('2d')]).toEqual([
      90 * MINUTE_MS,
      6 * 60 * MINUTE_MS,
      2 * DAY_MS,
    ]);
  });

  it('refuses a window without a unit, with a zero or with anything after it', () => {
    for (const value of ['90', '0h', '1.5h', '2w', '1d; drop', '', '-3h']) {
      expect(() => parseSince(value), value).toThrow(/--since/);
    }
  });
});

describe('parseRepublishArgs', () => {
  it('takes event types repeated, comma-separated, or both', () => {
    const { window, apply } = parseRepublishArgs([
      '--since',
      '1h',
      '--event-type',
      'order.paid,order.expired',
      '--event-type',
      ' catalog.product.changed ',
      '--event-type',
      'order.paid',
    ]);

    expect(apply).toBe(false);
    expect(window).toEqual({
      sinceMs: 60 * MINUTE_MS,
      eventTypes: ['order.paid', 'order.expired', 'catalog.product.changed'],
    });
  });

  it('selects every event type when none is named', () => {
    expect(parseRepublishArgs(['--since', '30m', '--apply'])).toEqual({
      window: { sinceMs: 30 * MINUTE_MS, eventTypes: [] },
      apply: true,
    });
  });

  // A typo in --event-type would otherwise republish every event type.
  it('refuses a missing window, an empty event type and any flag it does not know', () => {
    expect(() => parseRepublishArgs(['--apply'])).toThrow(/--since/);
    expect(() => parseRepublishArgs(['--since', '1h', '--event-type', ' , '])).toThrow(/--event-type/);
    expect(() => parseRepublishArgs(['--since', '1h', '--evnt-type', 'order.paid'])).toThrow(/evnt-type/);
  });
});

describe('republishOutbox', () => {
  // Older than the inbox window, a claim may be gone, and the redelivery would apply its effect twice.
  it('refuses a window as long as the inbox retention', async () => {
    const store = storeWith();

    await expect(
      republishOutbox(store, { window: { sinceMs: 30 * DAY_MS, eventTypes: [] }, dryRun: true, retention: RETENTION }),
    ).rejects.toThrow(/RETENTION_INBOX_DAYS/);
    await expect(
      republishOutbox(store, {
        window: { sinceMs: 30 * DAY_MS - 1, eventTypes: [] },
        dryRun: true,
        retention: RETENTION,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a window longer than the outbox keeps published rows', async () => {
    const retention = { inboxDays: 60, outboxDays: 7 };

    await expect(
      republishOutbox(storeWith(), { window: { sinceMs: 7 * DAY_MS + 1, eventTypes: [] }, dryRun: true, retention }),
    ).rejects.toThrow(/RETENTION_OUTBOX_DAYS/);
    await expect(
      republishOutbox(storeWith(), { window: { sinceMs: 7 * DAY_MS, eventTypes: [] }, dryRun: true, retention }),
    ).resolves.toBeDefined();
  });

  it('counts rows and claims on a dry run without resetting anything', async () => {
    const store = storeWith();
    const window = { sinceMs: 60 * MINUTE_MS, eventTypes: ['order.paid'] };

    const report = await republishOutbox(store, { window, dryRun: true, retention: RETENTION });

    expect(store.countByEventType).toHaveBeenCalledWith(window);
    expect(store.countClaimsByConsumer).toHaveBeenCalledWith(window);
    expect(store.resetPublished).not.toHaveBeenCalled();
    expect(report).toEqual({
      byEventType: [{ eventType: 'order.paid', rows: 3 }],
      claimsByConsumer: [{ consumer: 'domain-events', rows: 2 }],
      reset: 0,
    });
  });

  it('resets the window once applied', async () => {
    const store = storeWith();
    const window = { sinceMs: 60 * MINUTE_MS, eventTypes: [] };

    const report = await republishOutbox(store, { window, dryRun: false, retention: RETENTION });

    expect(store.resetPublished).toHaveBeenCalledWith(window);
    expect(report.reset).toBe(3);
  });
});
