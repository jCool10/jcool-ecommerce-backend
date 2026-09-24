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
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// One attempt, so a rejected dispatch reaches the failed set on the first delivery.
const ATTEMPTS = '1';
const BACKOFF_MS = '50';

const aggregateId = (n: number) => `0198f0d8-4444-7000-8000-${n.toString(16).padStart(12, '0')}`;

const seedRow = (n: number) => ({
  aggregateType: 'Order',
  aggregateId: aggregateId(n),
  eventType: 'order.placed',
  payload: { orderId: aggregateId(n), totalAmountMinor: 150_000 },
});

// BullMQ dedups `add` on whether the job key exists, not on whether the event was applied.
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

  // Known defect. Intended: the relay marks a row published only when a consumer will still see it.
  // Actual: OutboxRelay marks the row whatever queue.add did, and BullMQ ignores an add for a jobId
  // it still keeps in the failed set (removeOnFail keeps it a week), so the republish is swallowed.
  it('retires a row whose job sits in the failed set without applying the event', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new Error('handler refused the event'));
    const [row] = await seed(1);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    await waitForState(row.id, 'failed');
    expect(await claimsFor(row.id)).toHaveLength(0);

    // What a relay killed between the publish and its own commit leaves behind.
    await db.update(schema.outbox).set({ publishedAt: null }).where(eq(schema.outbox.id, row.id));
    vi.restoreAllMocks();

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

    expect(await stateOf(row.id)).toBe('failed');
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(0);
    expect(await claimsFor(row.id)).toHaveLength(0);

    expect((await byId(row.id)).publishedAt).not.toBeNull();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
    expect(await claimsFor(row.id)).toHaveLength(0);

    // The dead letter is the only trace left.
    expect(await deadLettersFor(row.id)).toHaveLength(1);
  });

  // Known defect. Intended: a row the queue permanently refuses reaches a terminal state. Actual:
  // OutboxRelay increments `attempts` and nothing reads it; only the backlog alerts in
  // slo-burn-rate.yml would notice the row.
  it('retries a permanently refused row forever without ever escalating it', async () => {
    spyOnEffect(dispatcher).mockResolvedValue(undefined);
    const [poison] = await seed(1);
    const add = queue.add.bind(queue);
    vi.spyOn(queue, 'add').mockImplementation((name: string, data: DomainEventJob, opts?: JobsOptions) =>
      opts?.jobId === poison.id
        ? Promise.reject(new Error('payload exceeds the maximum job size'))
        : add(name, data, opts),
    );

    // The relay charges an attempt only when a sibling in the batch got through. The tick count sits
    // past any plausible escalation threshold, so adding one turns this test red.
    const TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD = 12;
    for (let tick = 0; tick < TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD; tick += 1) {
      await db.insert(schema.outbox).values(seedRow(tick + 2));
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });
    }

    const [stuck] = await unpublished();
    expect(stuck.id).toBe(poison.id);
    expect(stuck.attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);

    expect(await deadLettersFor(poison.id)).toHaveLength(0);
    expect(await claimsFor(poison.id)).toHaveLength(0);
    expect(await stateOf(poison.id)).toBe('missing');

    // Alone in the backlog the row looks like a Redis outage, so even `attempts` stops moving.
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 1 });
    expect((await byId(poison.id)).attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);
  });
});
