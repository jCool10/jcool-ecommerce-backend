import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { DeadLetterJob } from './dead-letter';
import { replayDeadLetters } from './dead-letter.replay';

const ID_A = '0198f0d8-0000-7000-8000-00000000000a';
const ID_B = '0198f0d8-0000-7000-8000-00000000000b';

const dead = (overrides: Partial<DeadLetterJob> = {}): DeadLetterJob => ({
  outboxId: ID_A,
  aggregateType: 'Order',
  aggregateId: '0198f0d8-1111-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
  occurredAt: '2026-08-24T00:00:00.000Z',
  traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  failedReason: 'database unavailable',
  attemptsMade: 5,
  failedAt: '2026-08-24T00:00:05.000Z',
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

/**
 * The function takes nothing but two queues, so a pair of fakes reaches every branch — which is why
 * it lives apart from the CLI that calls it. `mainJobs` stands for the failed job still holding the
 * message id: the thing whose absence turns a naive replay into a silent no-op.
 */
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
  const getJobs = vi.fn().mockResolvedValue(entries);
  const getJob = vi.fn(mainGetJob ?? ((id: string) => Promise.resolve(mainJobs.get(id))));

  const main = { getJob, add } as unknown as Queue;
  const dlq = {
    getJobs,
    getJob: vi.fn((id: string) => Promise.resolve(dlqNow ? dlqNow(id) : entries.find((e) => e.id === id))),
  } as unknown as Queue;

  return { main, dlq, add, getJobs };
}

describe('replayDeadLetters', () => {
  it('changes nothing on a dry run and still reports every entry', async () => {
    const dlqJob = entry(dead());
    const { main, dlq, add } = build({ entries: [dlqJob] });

    const summary = await replayDeadLetters(main, dlq);

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(summary.outcomes[0]).toEqual({
      messageId: ID_A,
      eventType: 'order.placed',
      status: 'skipped',
      detail: 'dry run',
    });
  });

  it('frees the message id before reusing it, then re-publishes the envelope without the diagnosis', async () => {
    const dlqJob = entry(dead());
    const stale = entry(dead());
    const { main, dlq, add } = build({ entries: [dlqJob], mainJobs: new Map([[ID_A, stale]]) });

    const summary = await replayDeadLetters(main, dlq, { dryRun: false });

    // Without this removal `add` is ignored rather than rejected and the whole replay is a no-op.
    expect(stale.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);

    const [name, published, opts] = add.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(name).toBe('order.placed');
    expect(opts).toEqual({ jobId: ID_A });
    // The diagnosis is why the message is here, not part of the message — republishing it would
    // hand the consumer fields the envelope contract does not have.
    expect(Object.keys(published).sort()).toEqual(
      ['aggregateId', 'aggregateType', 'eventType', 'occurredAt', 'outboxId', 'payload', 'traceparent'].sort(),
    );
    expect(dlqJob.remove).toHaveBeenCalled();
    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
  });

  it('leaves a message alone while a worker is holding it', async () => {
    const dlqJob = entry(dead());
    const locked = entry(dead());
    locked.remove.mockRejectedValue(new Error('Job A could not be removed because it is locked by another worker'));
    const { main, dlq, add } = build({ entries: [dlqJob], mainJobs: new Map([[ID_A, locked]]) });

    const summary = await replayDeadLetters(main, dlq, { dryRun: false });

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toContain('locked');
  });

  it('keeps a fresher dead letter that landed while the message was being re-published', async () => {
    const dlqJob = entry(dead());
    const fresher = entry(dead({ failedAt: '2026-08-24T00:01:00.000Z', failedReason: 'and again' }));
    const { main, dlq } = build({ entries: [dlqJob], dlqNow: () => fresher });

    const summary = await replayDeadLetters(main, dlq, { dryRun: false });

    // Deleting it would hide the newer failure in the queue whose only job is to make it visible.
    expect(fresher.remove).not.toHaveBeenCalled();
    expect(summary.replayed).toBe(1);
  });

  it('refuses to replay an envelope it cannot key, rather than publishing under a bad id', async () => {
    const dlqJob = entry({ failedReason: 'Malformed domain event envelope (fields: none)' }, 'bullmq-job-id');
    const { main, dlq, add } = build({ entries: [dlqJob] });

    const summary = await replayDeadLetters(main, dlq, { dryRun: false });

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary.outcomes[0].messageId).toBe('bullmq-job-id');
    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toContain('malformed envelope');
  });

  it('reports the rest of the batch when one message fails — the summary is what the operator has', async () => {
    const bad = entry(dead());
    const good = entry(dead({ outboxId: ID_B }), ID_B);
    const { main, dlq } = build({
      entries: [bad, good],
      mainGetJob: (id) =>
        id === ID_A
          ? Promise.reject(new Error('ERR Lua redis lib command arguments must be strings or integers'))
          : Promise.resolve(undefined),
    });

    const summary = await replayDeadLetters(main, dlq, { dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 1 });
    expect(summary.outcomes[0].messageId).toBe(ID_A);
    expect(summary.outcomes[0].detail).toContain('Lua');
    expect(summary.outcomes[1]).toMatchObject({ messageId: ID_B, status: 'replayed' });
  });

  it('asks Redis for no more than the caller allowed', async () => {
    const { main, dlq, getJobs } = build();

    await replayDeadLetters(main, dlq, { limit: 20 });

    expect(getJobs).toHaveBeenCalledWith(['waiting', 'prioritized'], 0, 19, true);
  });
});
