import { describe, expect, it, vi } from 'vitest';
import { sampleId } from '@shared/testing/id-generator.double';
import type { ConsumerRetryRow } from '../retry/consumer-retry.store';
import { replayDeadLetters, type DeadLetterStore, type ReplayOptions } from './dead-letter.replay';
import type { DomainEventJob } from './domain-event.job';

const ID_A = sampleId(10);
const ID_B = sampleId(11);
const ORDER_ID = sampleId(1);
const CONSUMER = 'domain-events';

const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// No inbox claim, the ordinary case, so each test is about the branch it names.
const guards: Pick<ReplayOptions, 'inboxLookup' | 'inboxRetentionMs'> = {
  inboxLookup: () => Promise.resolve(null),
  inboxRetentionMs: 30 * DAY_MS,
};

const envelope = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
  outboxId: ID_A,
  aggregateType: 'Order',
  aggregateId: ORDER_ID,
  eventType: 'order.placed',
  payload: { orderId: ORDER_ID },
  // Relative, so the suite never crosses the retention horizon on a calendar date.
  occurredAt: ago(60_000),
  traceparent: null,
  ...overrides,
});

const dead = (overrides: Partial<DomainEventJob> = {}, row: Partial<ConsumerRetryRow> = {}): ConsumerRetryRow => {
  const env = envelope(overrides);
  return {
    consumer: CONSUMER,
    messageId: env.outboxId,
    eventType: env.eventType,
    envelope: env,
    attemptsMade: 8,
    nextAttemptAt: new Date(),
    leaseToken: null,
    status: 'dead',
    deadReason: 'attempts_exhausted',
    lastError: 'Error: database unavailable',
    firstFailedAt: new Date(Date.now() - 120_000),
    lastFailedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 120_000),
    ...row,
  };
};

function build(rows: ConsumerRetryRow[], revive = vi.fn().mockResolvedValue(true)) {
  const listDead = vi.fn().mockResolvedValue(rows);
  return { store: { listDead, revive } as DeadLetterStore, listDead, revive };
}

describe('replayDeadLetters', () => {
  it('hands a dead row back to the poller from the first rung', async () => {
    const { store, listDead, revive } = build([dead()]);

    const summary = await replayDeadLetters(store, { ...guards, dryRun: false, limit: 20, consumer: CONSUMER });

    expect(listDead).toHaveBeenCalledWith({ limit: 20, consumer: CONSUMER });
    expect(revive).toHaveBeenCalledWith({ consumer: CONSUMER, messageId: ID_A });
    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    expect(summary.outcomes[0]).toMatchObject({ consumer: CONSUMER, failedReason: 'Error: database unavailable' });
  });

  // A claim means the effect already happened; a revive would be a silent no-op read as a fix.
  it('refuses a message its consumer already applied, even when forced', async () => {
    const inboxLookup = vi.fn().mockResolvedValue(new Date('2026-08-01T10:00:00.000Z'));
    const { store, revive } = build([dead({}, { consumer: 'search-sync' })]);

    const summary = await replayDeadLetters(store, { ...guards, inboxLookup, dryRun: false, force: true });

    expect(inboxLookup).toHaveBeenCalledWith('search-sync', ID_A);
    expect(revive).not.toHaveBeenCalled();
    expect(summary.outcomes[0].detail).toContain('already applied');
  });

  // With no claim, only birth inside the window proves the inbox would still remember an apply.
  // `last_failed_at` moves on every failure, so it cannot decide.
  it('judges age by when the message was born, not when it last failed', async () => {
    const statusFor = async (occurredAt: string) => {
      const { store } = build([dead({ occurredAt }, { lastFailedAt: new Date(Date.now() - 60_000) })]);
      const summary = await replayDeadLetters(store, { ...guards, dryRun: false });
      return summary.outcomes[0].status;
    };

    const statuses = {
      inside: await statusFor(ago(29 * DAY_MS)),
      outside: await statusFor(ago(31 * DAY_MS)),
      unreadable: await statusFor('not a date'),
    };

    expect(statuses).toEqual({ inside: 'replayed', outside: 'skipped', unreadable: 'skipped' });
  });

  it('refuses to replay an envelope it cannot key', async () => {
    const row = dead({}, { envelope: {} as DomainEventJob, lastError: 'PermanentError: Malformed envelope' });
    const { store, revive } = build([row]);

    const summary = await replayDeadLetters(store, { ...guards, dryRun: false });

    expect(revive).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toMatchObject({ messageId: ID_A, eventType: 'unknown', status: 'skipped' });
    expect(summary.outcomes[0].detail).toContain('malformed envelope');
  });

  it('reports the rest of the batch when one message fails', async () => {
    const inboxLookup = (_consumer: string, messageId: string) =>
      messageId === ID_A ? Promise.reject(new Error('Connection terminated unexpectedly')) : Promise.resolve(null);
    const { store } = build([dead(), dead({ outboxId: ID_B })]);

    const summary = await replayDeadLetters(store, { ...guards, inboxLookup, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 1 });
    expect(summary.outcomes[0].messageId).toBe(ID_A);
    expect(summary.outcomes[0].detail).toContain('Connection terminated');
    expect(summary.outcomes[1]).toMatchObject({ messageId: ID_B, status: 'replayed' });
  });

  it('skips a row that was revived or removed after it was listed', async () => {
    const { store } = build([dead()], vi.fn().mockResolvedValue(false));

    const summary = await replayDeadLetters(store, { ...guards, dryRun: false });

    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toContain('no longer dead');
  });

  // A dry run that ignored the guard would promise a replay the apply run then refuses.
  it('runs the inbox guard on a dry run too', async () => {
    const { store, revive } = build([dead(), dead({ outboxId: ID_B, occurredAt: ago(31 * DAY_MS) })]);

    const summary = await replayDeadLetters(store, {
      ...guards,
      inboxLookup: (_consumer, id) => Promise.resolve(id === ID_A ? new Date('2026-08-01T10:00:00.000Z') : null),
      force: true,
    });

    expect(revive).not.toHaveBeenCalled();
    expect(summary.outcomes[0].detail).toContain('already applied');
    expect(summary.outcomes[1].detail).toBe('dry run (would be forced past the retention horizon)');
  });
});
