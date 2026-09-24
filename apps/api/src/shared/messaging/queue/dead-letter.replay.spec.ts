import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { DeadLetterJob } from './dead-letter';
import { replayDeadLetters, type ReplayOptions } from './dead-letter.replay';

const ID_A = '0198f0d8-0000-7000-8000-00000000000a';
const ID_B = '0198f0d8-0000-7000-8000-00000000000b';

const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// No inbox claim, the ordinary case, so each test is about the branch it names.
const guards: Pick<ReplayOptions, 'inboxLookup' | 'inboxRetentionMs' | 'jobOptionsFor'> = {
  inboxLookup: () => Promise.resolve(null),
  inboxRetentionMs: 30 * DAY_MS,
  jobOptionsFor: (eventType) => (eventType === 'order.paid' ? { attempts: 15 } : {}),
};

const dead = (overrides: Partial<DeadLetterJob> = {}): DeadLetterJob => ({
  outboxId: ID_A,
  aggregateType: 'Order',
  aggregateId: '0198f0d8-1111-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
  // Relative, so the suite never crosses the retention horizon on a calendar date.
  occurredAt: ago(60_000),
  traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  failedReason: 'database unavailable',
  attemptsMade: 5,
  failedAt: ago(60_000),
  ...overrides,
});

interface FakeJob {
  id?: string;
  data: Partial<DeadLetterJob>;
  remove: ReturnType<typeof vi.fn>;
}

const entry = (data: Partial<DeadLetterJob>, id = data.outboxId): FakeJob => ({
  id,
  data,
  remove: vi.fn().mockResolvedValue(undefined),
});

// `mainJobs` stands for the failed job still holding the message id.
function build({
  entries = [],
  mainJobs = new Map<string, FakeJob>(),
  mainGetJob,
  dlqNow,
}: {
  entries?: FakeJob[];
  mainJobs?: Map<string, FakeJob>;
  mainGetJob?: (id: string) => Promise<FakeJob | undefined>;
  dlqNow?: (id: string) => FakeJob | undefined;
} = {}) {
  const add = vi.fn().mockResolvedValue(undefined);
  const main = {
    getJob: vi.fn(mainGetJob ?? ((id: string) => Promise.resolve(mainJobs.get(id)))),
    add,
  } as unknown as Queue;
  const dlq = {
    getJobs: vi.fn().mockResolvedValue(entries),
    getJob: vi.fn((id: string) => Promise.resolve(dlqNow ? dlqNow(id) : entries.find((e) => e.id === id))),
  } as unknown as Queue;

  return { main, dlq, add };
}

describe('replayDeadLetters', () => {
  it('frees the message id, then re-publishes the bare envelope on its ladder', async () => {
    const dlqJob = entry(dead({ eventType: 'order.paid' }));
    const stale = entry(dead());
    const { main, dlq, add } = build({ entries: [dlqJob], mainJobs: new Map([[ID_A, stale]]) });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    // BullMQ ignores an add under a job id it still holds, so without this the replay is a no-op.
    expect(stale.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalledOnce();
    const [name, published, opts] = add.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(name).toBe('order.paid');
    expect(opts).toEqual({ jobId: ID_A, attempts: 15 });
    expect(Object.keys(published).sort()).toEqual(
      ['aggregateId', 'aggregateType', 'eventType', 'occurredAt', 'outboxId', 'payload', 'traceparent'].sort(),
    );
    expect(dlqJob.remove).toHaveBeenCalled();
    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
  });

  // With no claim, only birth inside the window proves the inbox would still remember an apply.
  // `failedAt` is re-stamped on every parking, so it cannot decide.
  it('judges age by when the message was born, not when it last failed', async () => {
    const statusFor = async (occurredAt: string) => {
      const { main, dlq } = build({ entries: [entry(dead({ occurredAt, failedAt: ago(60_000) }))] });
      const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });
      return summary.outcomes[0].status;
    };

    const statuses = {
      inside: await statusFor(ago(29 * DAY_MS)),
      outside: await statusFor(ago(31 * DAY_MS)),
      unreadable: await statusFor('not a date'),
    };

    expect(statuses).toEqual({ inside: 'replayed', outside: 'skipped', unreadable: 'skipped' });
  });

  it('leaves a message alone while a worker is holding it', async () => {
    const dlqJob = entry(dead());
    const locked = entry(dead());
    locked.remove.mockRejectedValue(new Error('Job A could not be removed because it is locked by another worker'));
    const { main, dlq, add } = build({ entries: [dlqJob], mainJobs: new Map([[ID_A, locked]]) });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toContain('locked');
  });

  // Deleting it would hide the newer failure in the queue whose only job is to make it visible.
  it('keeps a fresher dead letter that landed during the re-publish', async () => {
    const dlqJob = entry(dead());
    const fresher = entry(dead({ failedAt: '2026-08-24T00:01:00.000Z', failedReason: 'and again' }));
    const { main, dlq } = build({ entries: [dlqJob], dlqNow: () => fresher });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(fresher.remove).not.toHaveBeenCalled();
    expect(summary.replayed).toBe(1);
  });

  it('refuses to replay an envelope it cannot key', async () => {
    const dlqJob = entry({ failedReason: 'Malformed domain event envelope (fields: none)' }, 'bullmq-job-id');
    const { main, dlq, add } = build({ entries: [dlqJob] });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toMatchObject({ messageId: 'bullmq-job-id', status: 'skipped' });
    expect(summary.outcomes[0].detail).toContain('malformed envelope');
  });

  it('reports the rest of the batch when one message fails', async () => {
    const bad = entry(dead());
    const good = entry(dead({ outboxId: ID_B }), ID_B);
    const { main, dlq } = build({
      entries: [bad, good],
      mainGetJob: (id) =>
        id === ID_A
          ? Promise.reject(new Error('ERR Lua redis lib command arguments must be strings or integers'))
          : Promise.resolve(undefined),
    });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 1 });
    expect(summary.outcomes[0].messageId).toBe(ID_A);
    expect(summary.outcomes[0].detail).toContain('Lua');
    expect(summary.outcomes[1]).toMatchObject({ messageId: ID_B, status: 'replayed' });
  });

  // A dry run that ignored the guard would promise a replay the apply run then refuses.
  it('runs the inbox guard on a dry run too', async () => {
    const claimed = entry(dead(), ID_A);
    const forced = entry(dead({ outboxId: ID_B, occurredAt: ago(31 * DAY_MS) }), ID_B);
    const { main, dlq } = build({ entries: [claimed, forced] });

    const summary = await replayDeadLetters(main, dlq, {
      ...guards,
      inboxLookup: (id) => Promise.resolve(id === ID_A ? new Date('2026-08-01T10:00:00.000Z') : null),
      force: true,
    });

    expect(summary.outcomes[0].detail).toContain('already applied');
    expect(summary.outcomes[1].detail).toBe('dry run (would be forced past the retention horizon)');
  });
});
