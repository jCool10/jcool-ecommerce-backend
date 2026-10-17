import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { ConsumerDelivery } from '../../src/shared/messaging/consume/consumer-delivery';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_CONSUMER, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { ConsumerRetryStore, type ConsumerRetryRow } from '../../src/shared/messaging/retry/consumer-retry.store';
import { RetryPoller, type RetryTickSummary } from '../../src/shared/messaging/retry/retry-poller';
import { cappedBackoffMs } from '../../src/shared/messaging/retry/retry-policy';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import {
  closeAppAfterAll,
  createTestAppWithPool,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { idServiceStub, testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';

const CONSUMER = DOMAIN_EVENTS_CONSUMER;
const ATTEMPTS = 3;
const BACKOFF_MS = 100;
const ORDER_PAID_ATTEMPTS = 4;
const ORDER_PAID_CAP_MS = 400;
const WAIT = { timeout: 15_000, interval: 25 };
const LADDER_ENV = {
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
  QUEUE_CONSUMER_BACKOFF_MS: String(BACKOFF_MS),
  ORDER_PAID_CONSUMER_ATTEMPTS: String(ORDER_PAID_ATTEMPTS),
  ORDER_PAID_CONSUMER_BACKOFF_CAP_MS: String(ORDER_PAID_CAP_MS),
};

const envelope = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => {
  const orderId = testId();
  return {
    outboxId: testId(),
    aggregateType: 'Order',
    aggregateId: orderId,
    eventType: 'order.placed',
    payload: { orderId, totalAmountMinor: 150_000 },
    occurredAt: new Date().toISOString(),
    traceparent: null,
    ...overrides,
  };
};

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

// The poller runs by hand here (its scheduler is off), so every attempt is one a test asked for.
describe('Consumer retry ladder on Postgres (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let db: DrizzleDB;
  let pool: Pool;
  let delivery: ConsumerDelivery;
  let poller: RetryPoller;
  let store: ConsumerRetryStore;
  let dispatcher: DomainEventDispatcher;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(LADDER_ENV));
    delivery = app.get(ConsumerDelivery);
    poller = app.get(RetryPoller);
    store = app.get(ConsumerRetryStore);
    dispatcher = app.get(DomainEventDispatcher);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(async () => {
    vi.restoreAllMocks();
    (await idServiceStub()).reset();
  });

  const rows = () => db.select().from(schema.consumerRetries).orderBy(schema.consumerRetries.createdAt);
  const rowFor = async (messageId: string): Promise<ConsumerRetryRow | undefined> =>
    (await db.select().from(schema.consumerRetries).where(eq(schema.consumerRetries.messageId, messageId)))[0];
  const claimsFor = (messageId: string) => db.select().from(schema.inbox).where(eq(schema.inbox.messageId, messageId));
  const delayOf = (row: ConsumerRetryRow | undefined) =>
    row ? row.nextAttemptAt.getTime() - row.lastFailedAt.getTime() : Number.NaN;

  const untilDue = () =>
    vi.waitFor(async () => {
      const [{ notDue }] = await db
        .select({ notDue: sql<number>`count(*)::int` })
        .from(schema.consumerRetries)
        .where(sql`${schema.consumerRetries.status} = 'pending' and ${schema.consumerRetries.nextAttemptAt} > now()`);
      expect(notDue).toBe(0);
    }, WAIT);

  // What a lease running out looks like, without waiting the minute it takes.
  const expireLeases = () => db.update(schema.consumerRetries).set({ nextAttemptAt: sql`now()` });

  const runWhenDue = async (batch = 1): Promise<RetryTickSummary> => {
    await untilDue();
    return poller.runOnce(batch);
  };

  const counter = async (series: string, from = app): Promise<number> => {
    const { text } = await request(from.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    const line = text.split('\n').find((candidate) => candidate.startsWith(`${series} `));
    return line ? Number(line.slice(series.length + 1)) : 0;
  };

  it('keeps the default ladder timing, then buries the row once it is spent', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));
    const message = envelope();

    await expect(delivery.deliver(CONSUMER, message)).resolves.toBe('retrying');
    const delays = [delayOf(await rowFor(message.outboxId))];
    await expect(runWhenDue()).resolves.toMatchObject({ leased: 1, rescheduled: 1 });
    delays.push(delayOf(await rowFor(message.outboxId)));
    await expect(runWhenDue()).resolves.toMatchObject({ leased: 1, buried: 1 });

    expect(delays).toEqual([BACKOFF_MS, BACKOFF_MS * 2]);
    expect(await rowFor(message.outboxId)).toMatchObject({
      status: 'dead',
      deadReason: 'attempts_exhausted',
      attemptsMade: ATTEMPTS,
      leaseToken: null,
    });
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS);
  });

  it('walks order.paid up its own capped ladder', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new Error('user-service unavailable'));
    const message = envelope({ eventType: 'order.paid' });

    await delivery.deliver(CONSUMER, message);
    const delays = [delayOf(await rowFor(message.outboxId))];
    for (let attempt = 2; attempt < ORDER_PAID_ATTEMPTS; attempt += 1) {
      await runWhenDue();
      delays.push(delayOf(await rowFor(message.outboxId)));
    }
    await expect(runWhenDue()).resolves.toMatchObject({ buried: 1 });

    expect(delays).toEqual([1, 2, 3].map((n) => cappedBackoffMs(n, BACKOFF_MS, ORDER_PAID_CAP_MS)));
    expect(await rowFor(message.outboxId)).toMatchObject({ status: 'dead', attemptsMade: ORDER_PAID_ATTEMPTS });
  });

  it('applies the effect once when two pollers race for a row whose lease ran out', async () => {
    const held = gate();
    const effect = spyOnEffect(dispatcher)
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementationOnce(() => held.opened);
    const message = envelope();
    await delivery.deliver(CONSUMER, message);
    await untilDue();

    const first = poller.runOnce(1);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(2), WAIT);
    const firstLease = (await rowFor(message.outboxId))?.leaseToken;
    await expireLeases();
    const second = poller.runOnce(1);
    await vi.waitFor(async () => expect((await rowFor(message.outboxId))?.leaseToken).not.toBe(firstLease), WAIT);

    held.open();
    const [a, b] = await Promise.all([first, second]);

    expect(a.lost + b.lost).toBe(1);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(await claimsFor(message.outboxId)).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  it('hides a leased row from every other poller', async () => {
    const held = gate();
    const effect = spyOnEffect(dispatcher)
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementationOnce(() => held.opened);
    await delivery.deliver(CONSUMER, envelope());
    await untilDue();

    const first = poller.runOnce(1);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(2), WAIT);

    await expect(poller.runOnce(1)).resolves.toMatchObject({ leased: 0 });
    held.open();
    await expect(first).resolves.toMatchObject({ leased: 1, processed: 1 });
  });

  it('applies the effect once when a transient failure clears on the third attempt', async () => {
    const effect = spyOnEffect(dispatcher)
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'));
    const message = envelope();

    await delivery.deliver(CONSUMER, message);
    await expect(runWhenDue()).resolves.toMatchObject({ rescheduled: 1 });
    await expect(runWhenDue()).resolves.toMatchObject({ processed: 1 });

    expect(effect).toHaveBeenCalledTimes(3);
    expect(await claimsFor(message.outboxId)).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  // A process that dies mid-handler leaves its lease to run out; the attempt is still spent.
  it('charges an abandoned lease as an attempt and buries a row abandoned on its last one', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));
    const message = envelope();
    await delivery.deliver(CONSUMER, message);

    for (let attempt = 2; attempt <= ATTEMPTS; attempt += 1) {
      await untilDue();
      await expect(store.leaseOne(60_000)).resolves.toMatchObject({ attemptsMade: attempt });
      await expireLeases();
    }

    await expect(poller.runOnce(1)).resolves.toMatchObject({ leased: 1, buried: 1 });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await rowFor(message.outboxId)).toMatchObject({
      status: 'dead',
      deadReason: 'attempts_exhausted',
      attemptsMade: ATTEMPTS + 1,
    });
  });

  // Leasing the whole batch up front would let the rows behind a slow handler expire and be taken again.
  it('leases one row at a time', async () => {
    const held = gate();
    const effect = spyOnEffect(dispatcher)
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementationOnce(() => held.opened);
    for (let n = 0; n < 3; n += 1) await delivery.deliver(CONSUMER, envelope());
    await untilDue();

    const tick = poller.runOnce(3);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(4), WAIT);

    expect((await rows()).map((row) => row.leaseToken !== null)).toEqual([true, false, false]);
    held.open();
    await expect(tick).resolves.toMatchObject({ leased: 3, processed: 3 });
  });

  // The inbox claim mints its id over HTTP; the retry row must not depend on that.
  it('parks a delivery the id-service refused and applies it once the id-service is back', async () => {
    const effect = spyOnEffect(dispatcher).mockResolvedValue(undefined);
    const stub = await idServiceStub();
    const message = envelope();
    stub.fail(503);

    await expect(delivery.deliver(CONSUMER, message)).resolves.toBe('retrying');
    expect(await rowFor(message.outboxId)).toMatchObject({ status: 'pending', attemptsMade: 1 });
    expect(await claimsFor(message.outboxId)).toHaveLength(0);

    stub.reset();
    await expect(runWhenDue()).resolves.toMatchObject({ processed: 1 });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(await claimsFor(message.outboxId)).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  // The write would fail the same way on every redelivery, so handing it back would wedge the transport.
  it('dead-letters an envelope Postgres refuses to store, without a row or a redelivery', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new Error('handler refused'));
    const series = 'messaging_dlq_total{event_type="order.placed",reason="permanent"}';
    const before = await counter(series);

    await expect(delivery.deliver(CONSUMER, envelope({ payload: { note: 'nul \u0000 byte' } }))).resolves.toBe('dead');

    expect(await rows()).toHaveLength(0);
    expect(await counter(series)).toBe(before + 1);
  });

  // Only the root cause's name and message: a query wrapper's message carries its parameters.
  it('records the root cause of a failed query, never the query or its parameters', async () => {
    spyOnEffect(dispatcher).mockImplementation(async (_job, tx) => {
      await tx.execute(sql`select 1 / ${0}`);
    });
    const message = envelope();

    await expect(delivery.deliver(CONSUMER, message)).resolves.toBe('retrying');

    const row = await rowFor(message.outboxId);
    expect(row?.lastError).toBe('error: division by zero');
    expect(row?.lastError).not.toContain('Failed query');
  });

  describe('over BullMQ', () => {
    let bullmq: INestApplication;
    let queue: Queue;

    beforeAll(async () => {
      bullmq = await createTestApp({ ...LADDER_ENV, QUEUE_WORKER_ENABLED: 'true', MESSAGING_TRANSPORT: 'bullmq' });
      queue = bullmq.get<Queue>(DOMAIN_EVENTS_QUEUE);
    });
    closeAppAfterAll(() => bullmq);
    obliterateQueueBeforeEach(() => [queue]);

    // Only a retry row that cannot be written goes back to BullMQ, which then runs its own ladder.
    it('falls back to the transport ladder while the retry row cannot be written', async () => {
      const effect = spyOnEffect(bullmq.get(DomainEventDispatcher)).mockRejectedValue(new Error('handler refused'));
      const bullmqStore = bullmq.get(ConsumerRetryStore);
      vi.spyOn(bullmqStore, 'park').mockRejectedValue(new Error('Connection terminated unexpectedly'));
      const series = 'messaging_dlq_total{event_type="order.placed",reason="attempts_exhausted"}';
      const before = await counter(series, bullmq);
      const filed = envelope();

      await queue.add(filed.eventType, filed);

      await vi.waitFor(async () => expect(await rowFor(filed.outboxId)).toBeDefined(), WAIT);
      expect(await rowFor(filed.outboxId)).toMatchObject({
        status: 'dead',
        deadReason: 'attempts_exhausted',
        attemptsMade: ATTEMPTS,
        lastError: 'Error: Connection terminated unexpectedly',
      });
      expect(effect).toHaveBeenCalledTimes(ATTEMPTS);
      expect(await counter(series, bullmq)).toBe(before + 1);

      // With Postgres still refusing, the log line and the metric are all that is left.
      vi.spyOn(bullmqStore, 'insertDead').mockRejectedValue(new Error('Connection terminated unexpectedly'));
      const lost = envelope();
      await queue.add(lost.eventType, lost);

      await vi.waitFor(async () => expect(await counter(series, bullmq)).toBe(before + 2), WAIT);
      expect(await rowFor(lost.outboxId)).toBeUndefined();
    });
  });
});
