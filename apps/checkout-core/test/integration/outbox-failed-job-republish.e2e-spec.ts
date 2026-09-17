import type { INestApplication } from '@nestjs/common';
import { Job, type JobsOptions, type Queue } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DeadLetterJob } from '../../src/shared/messaging/queue/dead-letter';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import {
  DOMAIN_EVENTS_CONSUMER,
  DOMAIN_EVENTS_DLQ_QUEUE,
  DOMAIN_EVENTS_QUEUE,
} from '../../src/shared/messaging/queue/queue.constants';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// One attempt, so a rejected dispatch is terminal on the first delivery and the job reaches the
// failed set inside a test rather than after a whole exponential budget.
const ATTEMPTS = '1';
const BACKOFF_MS = '50';

// Zero-padded to a fixed width: the last uuid group is exactly 12 hex digits, so appending `n`
// unpadded silently produces an invalid uuid the moment n reaches double digits.
const aggregateId = (n: number) => `0198f0d8-4444-7000-8000-${n.toString(16).padStart(12, '0')}`;

const seedRow = (n: number) => ({
  aggregateType: 'Order',
  aggregateId: aggregateId(n),
  eventType: 'order.placed',
  payload: { orderId: aggregateId(n), totalAmountMinor: 150_000 },
});

/**
 * The relay's dedup is `queue.add(..., { jobId: row.id })`, and BullMQ answers it from whether the
 * job key still exists — not from whether the event was applied. This file drives the two states
 * where those two answers differ: a job that failed, and a row the queue never took at all.
 */
describe('Outbox relay against a job the queue already remembers (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let dispatcher: DomainEventDispatcher;
  let queue: Queue;
  let dlq: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  beforeAll(async () => {
    app = await createTestApp({
      // A real Worker, because the failed set is BullMQ's own bookkeeping and a hand-written
      // stand-in would only prove this file agrees with itself.
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: ATTEMPTS,
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    });
    relay = app.get(OutboxRelay);
    dispatcher = app.get(DomainEventDispatcher);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    dlq = app.get<Queue>(DOMAIN_EVENTS_DLQ_QUEUE);
    db = app.get<DrizzleDB>(DRIZZLE);
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    await dlq.obliterate({ force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = (count: number) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, (_, i) => seedRow(i + 1)))
      .returning();

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
  const byId = async (id: string) => (await db.select().from(schema.outbox).where(eq(schema.outbox.id, id)))[0];
  const claimsFor = (messageId: string) =>
    db
      .select()
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, DOMAIN_EVENTS_CONSUMER), eq(schema.inbox.messageId, messageId)));

  const stateOf = async (id: string): Promise<string> => {
    const job = await Job.fromId<DomainEventJob>(queue, id);
    return job ? job.getState() : 'missing';
  };

  const deadLettersFor = async (id: string): Promise<Job<DeadLetterJob>[]> => {
    const jobs = (await dlq.getJobs(['waiting', 'prioritized'])) as Job<DeadLetterJob>[];
    return jobs.filter((job) => job.id === id);
  };

  const waitForState = (id: string, state: string) =>
    vi.waitFor(async () => expect(await stateOf(id)).toBe(state), { timeout: 10_000, interval: 50 });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: the relay marks a row `published_at` only once the event is genuinely in
  //   flight, so a row it marks is a row some consumer will still see.
  // Violated at: src/shared/messaging/outbox/outbox-relay.ts:84 — the mark is unconditional on the
  //   `queue.add` at :135 having created anything. BullMQ ignores an `add` for a jobId that exists
  //   in ANY state, and `removeOnFail.age` (queue.constants.ts:45, the constant at :26) keeps a failed job's key for a
  //   week — so the republish after a crash is swallowed by the failed job it can never re-run, and
  //   the row is retired anyway. The completed-job branch of the same no-op is CORRECT dedup
  //   (saga-crash-convergence "moves the stock once when the relay republishes a row it never
  //   marked"); on the failed branch the identical line inverts its own meaning.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — OBX-1.
  it('retires a row whose job is sitting in the failed set, so the event is never applied', async () => {
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new Error('handler refused the event'));
    const [row] = await seed(1);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    await waitForState(row.id, 'failed');
    expect(await claimsFor(row.id)).toHaveLength(0);

    // The state a relay killed between the publish and its own commit leaves behind: the job exists,
    // the row still reads as unsent. Here the job has since exhausted its budget and failed, which
    // is the only difference from the crash the saga suite already covers.
    await db.update(schema.outbox).set({ publishedAt: null }).where(eq(schema.outbox.id, row.id));
    vi.restoreAllMocks();

    // The relay reports a publish...
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

    // ...but nothing was queued: the failed job still owns the id, and no delivery was created.
    expect(await stateOf(row.id)).toBe('failed');
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(0);
    expect(await claimsFor(row.id)).toHaveLength(0);

    // And the row is now off the relay's work queue for good — no later tick will look at it again,
    // with a healthy dispatcher or otherwise.
    expect((await byId(row.id)).publishedAt).not.toBeNull();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
    expect(await claimsFor(row.id)).toHaveLength(0);

    // The single remaining trace of the event, and it lives in Redis rather than in the outbox that
    // now claims delivery: recovery is a human replaying the DLQ, nothing automatic.
    expect(await deadLettersFor(row.id)).toHaveLength(1);
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a row the queue permanently refuses reaches a terminal state — dead-lettered
  //   or alarmed on — rather than being retried until someone happens to look.
  // Violated at: src/shared/messaging/outbox/outbox-relay.ts:94-97 — `attempts` is incremented and
  //   read by NOTHING: no threshold, no dead-letter, no branch anywhere in `src/` selects on it. The
  //   only escalation is the backlog gauge pair in
  //   src/shared/observability/metrics/outbox-backlog.collector.ts:11-12 (`outbox_backlog_pending`
  //   and `outbox_oldest_age_seconds`), which needs an alert rule outside this repository to matter.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — OBX-2.
  it('retries a permanently refused row forever without ever escalating it', async () => {
    // Healthy siblings consume cleanly, so nothing but the poison row can reach the DLQ.
    vi.spyOn(dispatcher, 'dispatch').mockResolvedValue(undefined);
    const [poison] = await seed(1);
    const add = queue.add.bind(queue);
    vi.spyOn(queue, 'add').mockImplementation((name: string, data: DomainEventJob, opts?: JobsOptions) =>
      opts?.jobId === poison.id
        ? Promise.reject(new Error('payload exceeds the maximum job size'))
        : add(name, data, opts),
    );

    // Each tick carries a healthy sibling alongside — the relay only charges an attempt once
    // something else in the batch got through, which is what proves the row itself was refused.
    //
    // The count is deliberately well past any threshold OBX-2 would plausibly choose. Three ticks
    // would have left this test green for any escalation rule that fires at 4 or more, which is the
    // opposite of what a characterization is for: it has to go red when the behaviour it pins is
    // fixed. If you add a threshold at or below this number, this test fails and should be rewritten
    // as a guard on the new terminal state.
    const TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD = 12;
    for (let tick = 0; tick < TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD; tick += 1) {
      await db.insert(schema.outbox).values(seedRow(tick + 2));
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });
    }

    const [stuck] = await unpublished();
    expect(stuck.id).toBe(poison.id);
    expect(stuck.attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);

    // Nothing consumed it, nothing gave up on it, nothing recorded it as beyond hope. The counter
    // climbs and the row simply stays in the backlog.
    expect(await deadLettersFor(poison.id)).toHaveLength(0);
    expect(await claimsFor(poison.id)).toHaveLength(0);
    expect(await stateOf(poison.id)).toBe('missing');

    // Worse without the healthy siblings: alone in the backlog the row cannot be told from a Redis
    // outage, so the relay declines to charge it at all and even `attempts` stops moving.
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 1 });
    expect((await byId(poison.id)).attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);
  });
});
