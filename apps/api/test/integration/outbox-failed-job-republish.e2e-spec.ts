import type { INestApplication } from '@nestjs/common';
import type { Job, JobState, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_CONSUMER, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { ConsumerRetryStore } from '../../src/shared/messaging/retry/consumer-retry.store';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { testId } from '../setup/id-service-stub';

// One attempt, so a delivery whose retry row cannot be written reaches the failed set at once.
const ATTEMPTS = '1';
const BACKOFF_MS = '50';
const ALL_STATES: JobState[] = ['waiting', 'delayed', 'prioritized', 'active', 'completed', 'failed'];

const seedRow = (orderId = testId()) => ({
  id: testId(),
  aggregateType: 'Order',
  aggregateId: orderId,
  eventType: 'order.placed',
  payload: { orderId, totalAmountMinor: 150_000 },
});

// The relay publishes without a job id, so an earlier job for the same row cannot swallow a new one.
describe('Outbox relay against a job the queue already remembers (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let dispatcher: DomainEventDispatcher;
  let retries: ConsumerRetryStore;
  let queue: Queue<DomainEventJob>;
  let db: DrizzleDB;
  let pool: Pool;

  beforeAll(async () => {
    app = await createTestApp({
      MESSAGING_TRANSPORT: 'bullmq',
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: ATTEMPTS,
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    });
    relay = app.get(OutboxRelay);
    dispatcher = app.get(DomainEventDispatcher);
    retries = app.get(ConsumerRetryStore);
    queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
    db = app.get<DrizzleDB>(DRIZZLE);
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = (count: number) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, () => seedRow()))
      .returning();

  const claimsFor = (messageId: string) =>
    db
      .select()
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, DOMAIN_EVENTS_CONSUMER), eq(schema.inbox.messageId, messageId)));
  const jobsFor = async (outboxId: string, states: JobState[] = ALL_STATES): Promise<Job<DomainEventJob>[]> =>
    (await queue.getJobs(states)).filter((job) => job.data?.outboxId === outboxId);

  const republish = (id: string) => db.update(schema.outbox).set({ publishedAt: null }).where(eq(schema.outbox.id, id));

  const waitForJobs = (id: string, state: JobState, count: number) =>
    vi.waitFor(async () => expect(await jobsFor(id, [state])).toHaveLength(count), { timeout: 10_000, interval: 50 });

  it('delivers a republished row again while its earlier job sits in the failed set', async () => {
    const effect = spyOnEffect(dispatcher);
    effect.mockRejectedValueOnce(new Error('handler refused the event'));
    // A retry row that cannot be written is the one failure still left to the transport.
    vi.spyOn(retries, 'park').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const [row] = await seed(1);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    await waitForJobs(row.id, 'failed', 1);
    expect(await claimsFor(row.id)).toHaveLength(0);

    await republish(row.id);
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    await waitForJobs(row.id, 'completed', 1);

    const [applied] = await jobsFor(row.id, ['completed']);
    expect(applied.returnvalue).toBe('processed');
    expect(await jobsFor(row.id, ['failed'])).toHaveLength(1);
    expect(await claimsFor(row.id)).toHaveLength(1);

    // Once more, now that the first copy applied: the inbox swallows it.
    await republish(row.id);
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    await waitForJobs(row.id, 'completed', 2);

    const results = (await jobsFor(row.id, ['completed'])).map((job) => job.returnvalue).sort();
    expect(results).toEqual(['duplicate', 'processed']);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(await claimsFor(row.id)).toHaveLength(1);
  });
});
