import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SagaKickExecutor } from '../../src/modules/order/application/saga/saga-kick.executor';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { PermanentError, UnhandledEventError } from '../../src/shared/messaging/errors';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DeadLetterJob } from '../../src/shared/messaging/queue/dead-letter';
import { replayDeadLetters } from '../../src/shared/messaging/queue/dead-letter.replay';
import { type DomainEventJob, jobIdFor } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import {
  DOMAIN_EVENTS_CONSUMER,
  DOMAIN_EVENTS_DLQ_QUEUE,
  DOMAIN_EVENTS_QUEUE,
} from '../../src/shared/messaging/queue/queue.constants';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import {
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readSaga,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { checkoutSessionCompleted, signWebhookAs } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_dead_letter_secret_01234';
const ATTEMPTS = 3;
// Collapsed from the shipped 1s so a whole budget elapses inside a test: 100ms, then 200ms.
const BACKOFF_MS = '100';

const MESSAGE_IDS = [testId(), testId(), testId()];
const messageId = (n: number) => MESSAGE_IDS[n];
const ORDER_ID = testId();

// A real BullMQ worker; assertions read where the message ended up.
describe('Retry, backoff and dead-letter queue (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let queue: Queue;
  let dlq: Queue;
  let db: DrizzleDB;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  const job = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
    outboxId: messageId(1),
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.placed',
    payload: { orderId: ORDER_ID, totalAmountMinor: 150_000 },
    // Relative: a fixed date would drift past the replay guard's inbox horizon.
    occurredAt: new Date().toISOString(),
    traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    ...overrides,
  });

  const inboxRows = () => db.select().from(schema.inbox);
  const deadLetters = () => dlq.getJobs(['waiting', 'prioritized']) as Promise<Job<DeadLetterJob>[]>;

  const inboxLookup = async (id: string): Promise<Date | null> => {
    const [row] = await db
      .select({ processedAt: schema.inbox.processedAt })
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, DOMAIN_EVENTS_CONSUMER), eq(schema.inbox.messageId, id)))
      .limit(1);
    return row?.processedAt ?? null;
  };

  // None of these events retries on a ladder of its own.
  const replayGuards = { inboxLookup, inboxRetentionMs: 30 * 86_400_000, jobOptionsFor: () => ({}) };

  const publish = (data: DomainEventJob) => queue.add(data.eventType, data, { jobId: jobIdFor(data.outboxId) });

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
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    }));
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(DomainEventDispatcher);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    dlq = app.get<Queue>(DOMAIN_EVENTS_DLQ_QUEUE);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [queue, dlq]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient failure to the end of the budget, then dead-letters it', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));
    const original = job();

    await publish(original);

    const [dead] = await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS);
    expect(dead.id).toBe(jobIdFor(original.outboxId));
    expect(dead.data).toMatchObject({
      outboxId: original.outboxId,
      aggregateType: 'Order',
      aggregateId: original.aggregateId,
      eventType: 'order.placed',
      payload: original.payload,
      traceparent: original.traceparent,
      attemptsMade: ATTEMPTS,
      failedReason: 'database unavailable',
    });
    expect(dead.data.failedAt).toEqual(expect.any(String));
    expect(await inboxRows()).toHaveLength(0);
  });

  it('lets a healthy message through while a poisoned one is still being retried', async () => {
    const effect = spyOnEffect(dispatcher).mockImplementation((delivered) =>
      delivered.outboxId === messageId(1) ? Promise.reject(new Error('poison')) : Promise.resolve(),
    );

    await publish(job());
    await publish(job({ outboxId: messageId(2) }));

    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect((await inboxRows())[0].messageId).toBe(messageId(2));

    await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS + 1);
  });

  it('stops retrying a failure no redelivery could fix and dead-letters it immediately', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('payload has no order id'));

    await publish(job());

    const [dead] = await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(dead.data.attemptsMade).toBe(1);
  });

  it('dead-letters an unregistered event type on the first attempt', async () => {
    await publish(job({ eventType: 'payment.refunded' }));

    const [dead] = await waitForDeadLetter();
    expect(dead.data.failedReason).toMatch(/No handler registered/);
    expect(dead.data.attemptsMade).toBe(1);
  });

  // A worker still on the previous release has no handler for an authorization, so it parks the event
  // instead of dropping it; the replay into the current handler is what moves the saga on.
  it('replays an authorization an older worker dead-lettered into the saga, which captures it once', async () => {
    const order = await placeAndOpenSession(app, await seedSellableSku(app, { onHand: 5 }));
    const intentId = gateway.authorize(order.sessionId);
    const completed = checkoutSessionCompleted(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' });
    await postWebhook(app, signWebhookAs(gateway, completed)).expect(200);
    const prepare = dispatcher.prepare.bind(dispatcher);
    const olderWorker = vi
      .spyOn(dispatcher, 'prepare')
      .mockImplementation((delivered) =>
        delivered.eventType === 'payment.authorized'
          ? Promise.reject(new UnhandledEventError(delivered.eventType))
          : prepare(delivered),
      );

    await app.get(OutboxRelay).runOnce(10);

    const [dead] = await waitForDeadLetter();
    expect(dead.data).toMatchObject({ eventType: 'payment.authorized', attemptsMade: 1 });
    expect(dead.data.failedReason).toMatch(/No handler registered/);
    expect((await readSaga(app, order.orderId)).step).toBe('AWAITING_AUTH');

    olderWorker.mockRestore();
    const summary = await replayDeadLetters(queue, dlq, { ...replayGuards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect((await readOrder(app, order.orderId)).status).toBe('PAID'), {
      timeout: 15_000,
      interval: 50,
    });
    await app.get(SagaKickExecutor).drain();
    expect((await readSaga(app, order.orderId)).step).toBe('COMPLETED');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await deadLetters()).toHaveLength(0);
  });

  it('replays a message once the handler is fixed and clears the dead letter', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();

    effect.mockRestore();
    const summary = await replayDeadLetters(queue, dlq, { ...replayGuards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(await deadLetters()).toHaveLength(0);
  });

  // Dead-lettered and claimed: what a crash between the effect's commit and the ack leaves.
  it('refuses to replay a message the inbox says was already applied, even forced', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();
    vi.restoreAllMocks();
    await expect(processor.process(job())).resolves.toBe('processed');

    const effect = spyOnEffect(dispatcher);
    const summary = await replayDeadLetters(queue, dlq, { ...replayGuards, dryRun: false, force: true });

    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(summary.outcomes[0].detail).toContain('already applied');
    expect(effect).not.toHaveBeenCalled();
    expect(await deadLetters()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  // Past the horizon a swept claim and a claim that never existed look the same.
  it('refuses a replay older than the inbox horizon unless forced', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();
    vi.restoreAllMocks();

    const aged = { ...replayGuards, inboxRetentionMs: 0, dryRun: false };
    const refused = await replayDeadLetters(queue, dlq, aged);

    expect(refused).toMatchObject({ replayed: 0, skipped: 1 });
    expect(refused.outcomes[0].detail).toContain('older than');
    expect(await deadLetters()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(0);

    const forced = await replayDeadLetters(queue, dlq, { ...aged, force: true });

    expect(forced).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
  });

  it('changes nothing on a dry run', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('nope'));
    await publish(job());
    await waitForDeadLetter();

    const summary = await replayDeadLetters(queue, dlq, replayGuards);

    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(await deadLetters()).toHaveLength(1);
  });

  it('applies the effect once when a transient failure clears mid-budget', async () => {
    const effect = spyOnEffect(dispatcher)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);

    await publish(job());

    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(await deadLetters()).toHaveLength(0);
  });

  it('reports retries and dead letters on /metrics', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));

    await publish(job());
    await waitForDeadLetter();

    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(text).toContain('messaging_consume_retries_total{event_type="order.placed"}');
    expect(text).toContain('messaging_dlq_total{event_type="order.placed",reason="attempts_exhausted"}');
  });
});
