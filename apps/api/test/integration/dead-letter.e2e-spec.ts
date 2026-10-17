import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { PermanentError } from '../../src/shared/messaging/errors';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { inboxClaimLookup } from '../../src/shared/messaging/inbox/inbox-claim.lookup';
import { replayDeadLetters, type ReplayOptions } from '../../src/shared/messaging/queue/dead-letter.replay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER } from '../../src/shared/messaging/queue/queue.constants';
import { ConsumerRetryStore, type ConsumerRetryRow } from '../../src/shared/messaging/retry/consumer-retry.store';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
} from '../../src/shared/messaging/transport/domain-event-publisher.port';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';

const ATTEMPTS = 3;
// Collapsed from the shipped 1s so a whole ladder elapses inside a test: 100ms, then 200ms.
const BACKOFF_MS = '100';
const WAIT = { timeout: 15_000, interval: 50 };

const MESSAGE_IDS = [testId(), testId(), testId()];
const messageId = (n: number) => MESSAGE_IDS[n];
const ORDER_ID = testId();

// A real consumer and a real retry poller; assertions read where the message ended up.
describe('Retry, backoff and dead-letter queue (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let retries: ConsumerRetryStore;
  let publisher: DomainEventPublisher;
  let db: DrizzleDB;
  let pool: Pool;

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
  const retryRows = () => db.select().from(schema.consumerRetries);
  const deadLetters = () => db.select().from(schema.consumerRetries).where(eq(schema.consumerRetries.status, 'dead'));

  let replayGuards: Pick<ReplayOptions, 'inboxLookup' | 'inboxRetentionMs'>;

  const publish = async (data: DomainEventJob) => {
    const [sent] = await publisher.publish([
      { rowId: data.outboxId, eventType: data.eventType, aggregateId: data.aggregateId, envelope: data },
    ]);
    expect(sent.ok).toBe(true);
  };

  const waitForDeadLetter = async (count = 1): Promise<ConsumerRetryRow[]> => {
    let rows: ConsumerRetryRow[] = [];
    await vi.waitFor(async () => {
      rows = await deadLetters();
      expect(rows).toHaveLength(count);
    }, WAIT);
    return rows;
  };

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      QUEUE_WORKER_ENABLED: 'true',
      MESSAGING_RETRY_ENABLED: 'true',
      MESSAGING_RETRY_POLL_MS: '100',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: BACKOFF_MS,
    }));
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(DomainEventDispatcher);
    retries = app.get(ConsumerRetryStore);
    publisher = app.get<DomainEventPublisher>(DOMAIN_EVENT_PUBLISHER);
    replayGuards = { inboxLookup: inboxClaimLookup(db), inboxRetentionMs: 30 * 86_400_000 };
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient failure to the end of the budget, then dead-letters it', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));
    const original = job();

    await publish(original);

    const [dead] = await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS);
    expect(dead).toMatchObject({
      consumer: DOMAIN_EVENTS_CONSUMER,
      messageId: original.outboxId,
      eventType: 'order.placed',
      envelope: original,
      attemptsMade: ATTEMPTS,
      deadReason: 'attempts_exhausted',
      lastError: 'Error: database unavailable',
      leaseToken: null,
    });
    expect(dead.lastFailedAt).toBeInstanceOf(Date);
    expect(await inboxRows()).toHaveLength(0);
  });

  it('lets a healthy message through while a poisoned one is still being retried', async () => {
    const effect = spyOnEffect(dispatcher).mockImplementation((delivered) =>
      delivered.outboxId === messageId(1) ? Promise.reject(new Error('poison')) : Promise.resolve(),
    );

    await publish(job());
    await publish(job({ outboxId: messageId(2) }));

    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), WAIT);
    expect((await inboxRows())[0].messageId).toBe(messageId(2));

    await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(ATTEMPTS + 1);
  });

  it('stops retrying a failure no redelivery could fix and dead-letters it immediately', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('payload has no order id'));

    await publish(job());

    const [dead] = await waitForDeadLetter();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(dead).toMatchObject({ attemptsMade: 1, deadReason: 'permanent' });
  });

  it('dead-letters an unregistered event type on the first attempt', async () => {
    await publish(job({ eventType: 'payment.refunded' }));

    const [dead] = await waitForDeadLetter();
    expect(dead.lastError).toMatch(/No handler registered/);
    expect(dead.attemptsMade).toBe(1);
  });

  it('replays a message once the handler is fixed and clears the dead letter', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();

    effect.mockRestore();
    const summary = await replayDeadLetters(retries, { ...replayGuards, dryRun: false });

    expect(summary).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => {
      expect(await inboxRows()).toHaveLength(1);
      expect(await retryRows()).toHaveLength(0);
    }, WAIT);
  });

  // Dead-lettered and claimed: what a crash between the effect's commit and the ack leaves.
  it('refuses to replay a message the inbox says was already applied, even forced', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('bug in the handler'));
    await publish(job());
    await waitForDeadLetter();
    vi.restoreAllMocks();
    await expect(processor.process(job(), DOMAIN_EVENTS_CONSUMER)).resolves.toBe('processed');

    const effect = spyOnEffect(dispatcher);
    const summary = await replayDeadLetters(retries, { ...replayGuards, dryRun: false, force: true });

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
    const refused = await replayDeadLetters(retries, aged);

    expect(refused).toMatchObject({ replayed: 0, skipped: 1 });
    expect(refused.outcomes[0].detail).toContain('older than');
    expect(await deadLetters()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(0);

    const forced = await replayDeadLetters(retries, { ...aged, force: true });

    expect(forced).toMatchObject({ replayed: 1, skipped: 0 });
    await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), WAIT);
  });

  it('changes nothing on a dry run', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new PermanentError('nope'));
    await publish(job());
    const [before] = await waitForDeadLetter();

    const summary = await replayDeadLetters(retries, replayGuards);

    expect(summary).toMatchObject({ replayed: 0, skipped: 1 });
    expect(await deadLetters()).toEqual([before]);
  });

  it('applies the effect once when a transient failure clears mid-budget', async () => {
    const effect = spyOnEffect(dispatcher)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);

    await publish(job());

    await vi.waitFor(async () => {
      expect(await inboxRows()).toHaveLength(1);
      expect(await retryRows()).toHaveLength(0);
    }, WAIT);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('reports retries and dead letters on /metrics', async () => {
    spyOnEffect(dispatcher).mockRejectedValue(new Error('database unavailable'));

    await publish(job());
    await waitForDeadLetter();

    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(text).toContain('messaging_consume_retries_total{event_type="order.placed"}');
    expect(text).toContain('messaging_dlq_total{event_type="order.placed",reason="attempts_exhausted"}');
    expect(text).toContain(`messaging_dead_letters{consumer="${DOMAIN_EVENTS_CONSUMER}"} 1`);
  });
});
