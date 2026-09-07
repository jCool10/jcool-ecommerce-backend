import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { PermanentError } from '../../src/shared/messaging/errors';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import type { DeadLetterJob } from '../../src/shared/messaging/queue/dead-letter';
import { replayDeadLetters } from '../../src/shared/messaging/queue/dead-letter.replay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import {
  DOMAIN_EVENTS_CONSUMER,
  DOMAIN_EVENTS_DLQ_QUEUE,
  DOMAIN_EVENTS_QUEUE,
} from '../../src/shared/messaging/queue/queue.constants';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-dead-letter-metrics-token';
const ATTEMPTS = 3;
// Collapsed from the shipped 1s so a whole budget elapses inside a test: 100ms, then 200ms.
const BACKOFF_MS = '100';

const messageId = (n: number) => `0198f0d8-2222-7000-8000-00000000000${n}`;

/**
 * What happens after a consume fails, against a real queue.
 *
 * Retry counting and the terminal/transient split are BullMQ's, read back rather than reimplemented,
 * so a fake would only prove that this suite agrees with itself. Everything here runs a genuine
 * Worker against a container and asserts on where the message physically ended up.
 */
describe('Retry, backoff and dead-letter queue (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let queue: Queue;
  let dlq: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  const job = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
    outboxId: messageId(1),
    aggregateType: 'Order',
    aggregateId: '0198f0d8-3333-7000-8000-000000000001',
    eventType: 'order.placed',
    payload: { orderId: '0198f0d8-3333-7000-8000-000000000001', totalAmountMinor: 150_000 },
    // Relative, not a literal: the replay guard reads this field to decide whether a missing inbox
    // claim proves anything, so a fixed date would drift out of the retention window and start
    // failing this suite on a calendar day rather than on a change.
    occurredAt: new Date().toISOString(),
    traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    ...overrides,
  });

  const inboxRows = () => db.select().from(schema.inbox);
  const deadLetters = () => dlq.getJobs(['waiting', 'prioritized']) as Promise<Job<DeadLetterJob>[]>;

  // The replay CLI's own lookup, against the same table the worker writes its claim into. Passing a
  // fake here would prove only that the guard agrees with itself; the whole question is whether it
  // reads the row the consumer actually wrote.
  const inboxLookup = async (id: string): Promise<Date | null> => {
    const [row] = await db
      .select({ processedAt: schema.inbox.processedAt })
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, DOMAIN_EVENTS_CONSUMER), eq(schema.inbox.messageId, id)))
      .limit(1);
    return row?.processedAt ?? null;
  };

  const replayGuards = { inboxLookup, inboxRetentionMs: 30 * 86_400_000 };

  // The worker runs in this same app, so a spy on the dispatcher it resolved is the seam every
  // failure mode below is injected through.
  const publish = (data: DomainEventJob) => queue.add(data.eventType, data, { jobId: data.outboxId });

  const waitForDeadLetter = async (count = 1): Promise<Job<DeadLetterJob>[]> => {
    let jobs: Job<DeadLetterJob>[] = [];
    await vi.waitFor(
      async () => {
        jobs = await deadLetters();
        expect(jobs).toHaveLength(count);
      },
      { timeout: 15_000, interval: 50 },
    );
    return jobs;
  };

  beforeAll(async () => {
    app = await createTestApp({
      METRICS_TOKEN,
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    });
    processor = app.get(DomainEventProcessor);
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

  it('retries a transient failure to the end of the budget, then dead-letters it', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new Error('database unavailable'));

    await publish(job());

    const [dead] = await waitForDeadLetter();
    // Every attempt was actually spent — a DLQ reached on the first failure would be retry that
    // never ran, and is indistinguishable from this one by looking at the DLQ alone.
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS);
    expect(dead.data.attemptsMade).toBe(ATTEMPTS);
    expect(dead.data.failedReason).toBe('database unavailable');
    // Nothing applied: the claim rolled back with each failed effect.
    expect(await inboxRows()).toHaveLength(0);
  });

  it('lets a healthy message through while a poisoned one is still being retried', async () => {
    const effect = vi
      .spyOn(dispatcher, 'dispatch')
      .mockImplementation((delivered) =>
        delivered.outboxId === messageId(1) ? Promise.reject(new Error('poison')) : Promise.resolve(),
      );

    await publish(job());
    await publish(job({ outboxId: messageId(2) }));

    // The point of a dead-letter queue: head-of-line blocking is what happens without one.
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect((await inboxRows())[0].messageId).toBe(messageId(2));

    await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS + 1);
  });

  it('stops retrying a failure no redelivery could fix and dead-letters it immediately', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('payload has no order id'));

    await publish(job());

    const [dead] = await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(dead.data.attemptsMade).toBe(1);
  });

  it('treats an event nothing is registered for as permanent rather than burning the budget', async () => {
    // The real path, no spy: a producer shipping an event type ahead of its consumer.
    await publish(job({ eventType: 'payment.refunded' }));

    const [dead] = await waitForDeadLetter();
    expect(dead.data.failedReason).toMatch(/No handler registered/);
    expect(dead.data.attemptsMade).toBe(1);
  });

  it('carries everything needed to reconcile the message by hand', async () => {
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('nope'));

    const original = job();
    await publish(original);

    const [dead] = await waitForDeadLetter();
    expect(dead.data).toMatchObject({
      outboxId: original.outboxId,
      aggregateType: 'Order',
      aggregateId: original.aggregateId,
      eventType: 'order.placed',
      payload: original.payload,
      // Kept so a replay reopens the trace that produced the message rather than starting a new one.
      traceparent: original.traceparent,
      failedReason: 'nope',
    });
    expect(dead.data.failedAt).toEqual(expect.any(String));
    // Deduped on the message, so a second poisoning of the same event does not stack up copies.
    expect(dead.id).toBe(original.outboxId);
  });

  it('applies the message on replay once the handler is fixed, and clears the dead letter', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();

    effect.mockRestore();
    const summary = await replayDeadLetters(queue, dlq, { ...replayGuards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(await deadLetters()).toHaveLength(0);
  });

  it('refuses a message the inbox says was already applied, rather than reporting a no-op as a fix', async () => {
    // Reaches the dead-letter queue and the inbox, which is the state a crash between the effect's
    // commit and the ack leaves behind — the case that makes replay look dangerous.
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();
    vi.restoreAllMocks();
    await expect(processor.process(job())).resolves.toBe('processed');

    const effect = vi.spyOn(dispatcher, 'dispatch');
    const summary = await replayDeadLetters(queue, dlq, { ...replayGuards, dryRun: false, force: true });

    // The inbox would have collapsed the duplicate anyway, so the effect was never at risk — what is
    // at risk is the operator, who reads "replayed 1" and stops looking for the real problem. Not
    // even --force gets past a claim that is actually there.
    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(summary.outcomes[0].detail).toContain('already applied');
    expect(effect).not.toHaveBeenCalled();
    expect(await deadLetters()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('refuses a replay older than the inbox horizon, where a missing claim proves nothing, until --force', async () => {
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();
    vi.restoreAllMocks();

    // A horizon of zero puts every failure past it — the shape of a dead letter that outlived inbox
    // retention, where a swept claim and a claim that never existed look identical.
    const aged = { ...replayGuards, inboxRetentionMs: 0, dryRun: false };
    const refused = await replayDeadLetters(queue, dlq, aged);

    expect(refused).toMatchObject({ replayed: 0, skipped: 1 });
    expect(refused.outcomes[0].detail).toContain('older than');
    expect(await deadLetters()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(0);

    // Same message, same horizon: only the operator's assertion that it was never applied changes.
    const forced = await replayDeadLetters(queue, dlq, { ...aged, force: true });

    expect(forced).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
  });

  it('changes nothing on a dry run, so an operator can look before replaying', async () => {
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new PermanentError('nope'));
    await publish(job());
    await waitForDeadLetter();

    const summary = await replayDeadLetters(queue, dlq, replayGuards);

    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(await deadLetters()).toHaveLength(1);
  });

  it('applies the effect once when a transient failure clears mid-budget', async () => {
    const effect = vi
      .spyOn(dispatcher, 'dispatch')
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);

    await publish(job());

    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(await deadLetters()).toHaveLength(0);
  });

  it('reports retries and dead letters on /metrics', async () => {
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValue(new Error('database unavailable'));

    await publish(job());
    await waitForDeadLetter();

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    // Presence, not value: counters accumulate across the tests in this file, so only a delta would
    // be meaningful (the registry itself is per-file — vitest isolates each e2e file in its own
    // process).
    expect(text).toContain('messaging_consume_retries_total{event_type="order.placed"}');
    expect(text).toContain('messaging_dlq_total{event_type="order.placed",reason="attempts_exhausted"}');
  });
});
