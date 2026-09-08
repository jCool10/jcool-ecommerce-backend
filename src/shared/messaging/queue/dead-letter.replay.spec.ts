import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { DeadLetterJob } from './dead-letter';
import { replayDeadLetters, type ReplayOptions } from './dead-letter.replay';

const ID_A = '0198f0d8-0000-7000-8000-00000000000a';
const ID_B = '0198f0d8-0000-7000-8000-00000000000b';

const DAY_MS = 86_400_000;
const RETENTION_MS = 30 * DAY_MS;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// No inbox claim — the ordinary case, so every test below is about the branch it names.
const guards: Pick<ReplayOptions, 'inboxLookup' | 'inboxRetentionMs'> = {
  inboxLookup: () => Promise.resolve(null),
  inboxRetentionMs: RETENTION_MS,
};

const dead = (overrides: Partial<DeadLetterJob> = {}): DeadLetterJob => ({
  outboxId: ID_A,
  aggregateType: 'Order',
  aggregateId: '0198f0d8-1111-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
  // Relative, not a fixed date: `occurredAt` decides branch 3, so a literal would cross the
  // retention horizon one day and fail this suite on a calendar date rather than on a change.
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

// `mainJobs` stands for the failed job still holding the message id — the thing whose absence turns
// a naive replay into a silent no-op.
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

    const summary = await replayDeadLetters(main, dlq, guards);

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

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    // Without this removal `add` is ignored rather than rejected and the whole replay is a no-op.
    expect(stale.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);

    const [name, published, opts] = add.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(name).toBe('order.placed');
    expect(opts).toEqual({ jobId: ID_A });
    // The diagnosis is why the message is here, not part of it — republishing it would hand the
    // consumer fields the envelope contract does not have.
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

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(add).not.toHaveBeenCalled();
    expect(dlqJob.remove).not.toHaveBeenCalled();
    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toContain('locked');
  });

  it('keeps a fresher dead letter that landed while the message was being re-published', async () => {
    const dlqJob = entry(dead());
    const fresher = entry(dead({ failedAt: '2026-08-24T00:01:00.000Z', failedReason: 'and again' }));
    const { main, dlq } = build({ entries: [dlqJob], dlqNow: () => fresher });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    // Deleting it would hide the newer failure in the queue whose only job is to make it visible.
    expect(fresher.remove).not.toHaveBeenCalled();
    expect(summary.replayed).toBe(1);
  });

  it('refuses to replay an envelope it cannot key, rather than publishing under a bad id', async () => {
    const dlqJob = entry({ failedReason: 'Malformed domain event envelope (fields: none)' }, 'bullmq-job-id');
    const { main, dlq, add } = build({ entries: [dlqJob] });

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

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

    const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 1 });
    expect(summary.outcomes[0].messageId).toBe(ID_A);
    expect(summary.outcomes[0].detail).toContain('Lua');
    expect(summary.outcomes[1]).toMatchObject({ messageId: ID_B, status: 'replayed' });
  });

  it('asks Redis for no more than the caller allowed', async () => {
    const { main, dlq, getJobs } = build();

    await replayDeadLetters(main, dlq, { ...guards, limit: 20 });

    expect(getJobs).toHaveBeenCalledWith(['waiting', 'prioritized'], 0, 19, true);
  });

  // Only the inbox knows whether the effect already happened, and when it says nothing only
  // `occurredAt` establishes that its silence means anything.
  describe('the inbox guard', () => {
    const applied = new Date('2026-08-01T10:00:00.000Z');

    it('refuses a message the inbox says was already applied, and --force cannot override it', async () => {
      const dlqJob = entry(dead());
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, {
        ...guards,
        inboxLookup: () => Promise.resolve(applied),
        dryRun: false,
        force: true,
      });

      // Replaying it would collapse on the inbox's unique index while the operator reads "replayed".
      expect(add).not.toHaveBeenCalled();
      expect(dlqJob.remove).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
      expect(summary.outcomes[0].detail).toContain('already applied at 2026-08-01T10:00:00.000Z');
      expect(summary.outcomes[0].detail).toContain('--force cannot override');
    });

    it('replays when there is no claim and the message was born inside the retention window', async () => {
      const dlqJob = entry(dead({ occurredAt: ago(29 * DAY_MS) }));
      const lookup = vi.fn(() => Promise.resolve(null));
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, { ...guards, inboxLookup: lookup, dryRun: false });

      // Keyed by the message id, not the BullMQ job id — the claim it must match is the outbox row id.
      expect(lookup).toHaveBeenCalledWith(ID_A);
      expect(add).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    });

    it('refuses a message born before the retention window, where "no claim" proves nothing', async () => {
      const dlqJob = entry(dead({ occurredAt: ago(31 * DAY_MS) }));
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

      expect(add).not.toHaveBeenCalled();
      expect(summary.outcomes[0].detail).toContain('older than the 30-day inbox retention');
      expect(summary.outcomes[0].detail).toContain('--force');
    });

    // `dead-letter.ts` re-stamps `failedAt` on every parking, so an ancient message parked again
    // this morning looks brand new. Birth cannot be re-stamped.
    it('decides on when the message was born, not on when it last failed', async () => {
      const dlqJob = entry(dead({ occurredAt: ago(31 * DAY_MS), failedAt: ago(60_000) }));
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

      expect(add).not.toHaveBeenCalled();
      expect(summary.outcomes[0].detail).toContain('older than the 30-day inbox retention');
    });

    it('lets --force past the age check once a human has confirmed it was never applied', async () => {
      const dlqJob = entry(dead({ occurredAt: ago(31 * DAY_MS) }));
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false, force: true });

      expect(add).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    });

    // `isWellFormedEnvelope` vets `outboxId` and `eventType` only, so this field really can arrive
    // unusable — and the branch fails closed rather than reading NaN as "inside the window".
    it('treats an unreadable occurredAt as born too long ago — an unprovable replay is refused', async () => {
      const dlqJob = entry(dead({ occurredAt: 'not a date' }));
      const { main, dlq, add } = build({ entries: [dlqJob] });

      const summary = await replayDeadLetters(main, dlq, { ...guards, dryRun: false });

      expect(add).not.toHaveBeenCalled();
      expect(summary.outcomes[0].status).toBe('skipped');
    });

    it('runs the guard on a dry run too, so the listing is what --apply would actually do', async () => {
      const claimed = entry(dead(), ID_A);
      const forced = entry(dead({ outboxId: ID_B, occurredAt: ago(31 * DAY_MS) }), ID_B);
      const { main, dlq } = build({ entries: [claimed, forced] });

      const summary = await replayDeadLetters(main, dlq, {
        ...guards,
        inboxLookup: (id) => Promise.resolve(id === ID_A ? applied : null),
        force: true,
      });

      // A dry run that ignored the guard would promise a replay the apply run then refuses.
      expect(summary.outcomes[0].detail).toContain('already applied');
      expect(summary.outcomes[1].detail).toBe('dry run (would be forced past the retention horizon)');
    });
  });
});
