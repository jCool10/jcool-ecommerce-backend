import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_EVENTS_DLQ } from '@jcool/internal-contracts/queues/order-events';
import {
  type DeadLetterJob,
  type DomainEventJob,
  PermanentError,
  jobIdFor,
  queueToken,
  replayDeadLetters,
} from '@jcool/messaging';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { API_EVENTS_CONSUMER, API_EVENTS_DLQ, API_EVENTS_QUEUE } from '../../src/shared/messaging/event-routes';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import {
  closeAppAfterAll,
  createTestAppWithPool,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { testId } from '../setup/id-service-stub';

const ATTEMPTS = 3;
// Collapsed from the shipped 1s so a whole budget elapses inside a test: 100ms, then 200ms.
const BACKOFF_MS = '100';
const PRODUCT_ID = testId();

// The order-events cases run in the order-service; these are the api-events side of the same contract.
describe('Retry, backoff and dead-letter queue (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let dispatcher: DomainEventDispatcher;
  let apiQueue: Queue;
  let apiDlq: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  const catalogJob = (): DomainEventJob => ({
    outboxId: testId(),
    aggregateType: 'Product',
    aggregateId: PRODUCT_ID,
    eventType: 'catalog.product.changed',
    payload: {},
    // Relative: a fixed date would drift past the replay guard's inbox horizon.
    occurredAt: new Date().toISOString(),
    traceparent: null,
  });

  const inboxRows = () => db.select().from(schema.inbox);
  const deadLetters = () => apiDlq.getJobs(['waiting', 'prioritized']) as Promise<Job<DeadLetterJob>[]>;

  const inboxLookup = async (id: string): Promise<Date | null> => {
    const [row] = await db
      .select({ processedAt: schema.inbox.processedAt })
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, API_EVENTS_CONSUMER), eq(schema.inbox.messageId, id)))
      .limit(1);
    return row?.processedAt ?? null;
  };

  const publish = (data: DomainEventJob) => apiQueue.add(data.eventType, data, { jobId: jobIdFor(data.outboxId) });

  const waitForDeadLetter = async (): Promise<Job<DeadLetterJob>[]> => {
    let jobs: Job<DeadLetterJob>[] = [];
    await vi.waitFor(
      async () => {
        jobs = await deadLetters();
        expect(jobs).toHaveLength(1);
      },
      { timeout: 15_000, interval: 50 },
    );
    return jobs;
  };

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    }));
    dispatcher = app.get(DomainEventDispatcher);
    apiQueue = app.get<Queue>(queueToken(API_EVENTS_QUEUE));
    apiDlq = app.get<Queue>(queueToken(API_EVENTS_DLQ));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [apiQueue, apiDlq]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parks a poisoned catalog event in the api-events dead-letter queue, not the order-events one', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));

    await publish(catalogJob());

    const [dead] = await waitForDeadLetter();
    expect(dead.data.eventType).toBe('catalog.product.changed');
    // This process does not even hold an order-events dead-letter queue to park it in.
    expect(() => app.get(queueToken(ORDER_EVENTS_DLQ))).toThrow();
  });

  it('replays a message once the handler is fixed and clears the dead letter', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(catalogJob());
    await waitForDeadLetter();

    effect.mockRestore();
    const summary = await replayDeadLetters(apiQueue, apiDlq, {
      inboxLookup,
      inboxRetentionMs: 30 * 86_400_000,
      jobOptionsFor: () => ({}),
      dryRun: false,
    });

    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(await deadLetters()).toHaveLength(0);
  });
});
