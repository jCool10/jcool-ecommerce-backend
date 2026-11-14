import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_EVENTS_DLQ, ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import {
  type DeadLetterJob,
  type DomainEventJob,
  DomainEventProcessor,
  OutboxRelay,
  jobIdFor,
  queueToken,
} from '@jcool/messaging';
import { ORDER_REFUNDED_EVENT } from '../../src/modules/order/application/order-outbox.mapper';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { type UserServiceStub, userServiceStub } from '../setup/user-service-stub';

const MAIL_FROM = 'no-reply@jcool.test';
const ORDER_ID = testId();
const ADMIN_ID = testId();
// Above the shipped 10s: a cold container's first SMTP connection can outlast it.
const MAIL_TIMEOUT_MS = '20000';

const refundedPayload = (userId: string) => ({
  orderId: ORDER_ID,
  userId,
  occurredAt: new Date().toISOString(),
  totalAmountMinor: 300_000,
  currency: 'VND',
  paymentRef: null,
  requestedBy: ADMIN_ID,
  reason: 'admin:refund',
});

const refundedJob = (userId: string, outboxId = testId()): DomainEventJob => ({
  outboxId,
  aggregateType: 'Order',
  aggregateId: ORDER_ID,
  eventType: ORDER_REFUNDED_EVENT,
  payload: refundedPayload(userId),
  occurredAt: new Date().toISOString(),
  traceparent: null,
});

// Deliveries are driven by hand here; the queue worker is off in e2e.
describe('Refund mail (integration, real Mailpit + Postgres + Redis)', () => {
  let mail: StartedMailServer;
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let db: DrizzleDB;
  let pool: Pool;

  const inboxRows = () => db.select().from(schema.inbox);

  beforeAll(async () => {
    mail = await startMailServer();
    ({ app, pool, db } = await createTestAppWithPool({
      SMTP_URL: mail.smtpUrl,
      MAIL_FROM,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      MAIL_TIMEOUT_MS,
    }));
    processor = app.get(DomainEventProcessor);
  }, 180_000);

  // The app closes before the mail server it holds a connection to.
  afterAll(async () => {
    await app?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await mail.clear();
  });

  it('mails the buyer once per refund, however often the message is redelivered', async () => {
    const { user } = await createTestPrincipal(app);
    const job = refundedJob(user.id);

    await expect(processor.process(job, ORDER_EVENTS_QUEUE)).resolves.toBe('processed');
    const [delivered] = await mail.waitForMail(user.email);
    await expect(processor.process(job, ORDER_EVENTS_QUEUE)).resolves.toBe('duplicate');

    expect(delivered.Subject).toBe('Your refund has been issued');
    const body = await mail.body(delivered.ID);
    expect(body).toContain(ORDER_ID);
    expect(body).not.toContain(ADMIN_ID);
    // process() awaits the post-commit effect, so a second send would already be here.
    expect(await mail.messages()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  // A retry would only find its own claim, so a lost mail is counted instead of retried.
  it('keeps the message applied when the mail cannot be delivered, counting it once', async () => {
    const { user } = await createTestPrincipal(app);
    const broken = await createTestApp({ SMTP_URL: UNREACHABLE_SMTP_URL, MAIL_FROM, METRICS_TOKEN: E2E_METRICS_TOKEN });
    try {
      await expect(broken.get(DomainEventProcessor).process(refundedJob(user.id), ORDER_EVENTS_QUEUE)).resolves.toBe(
        'processed',
      );

      expect(await inboxRows()).toHaveLength(1);
      expect(await mail.messages()).toHaveLength(0);
      const { text } = await request(broken.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
      expect(text).toMatch(/mail_send_failures_total\{kind="order_refunded"\} 1\b/);
      expect(text).toContain(`messaging_consume_total{event_type="${ORDER_REFUNDED_EVENT}",result="processed"}`);
    } finally {
      await broken.close();
    }
  });
});

// The default ladder dead-letters after this many attempts; order.refunded rides the long one.
const ATTEMPTS = 3;
const BACKOFF_MS = 100;
const LONG_LADDER_ATTEMPTS = 8;
const LONG_LADDER_CAP_MS = 400;

describe('Refund mail against the user directory (integration, real relay and queue worker)', () => {
  let mail: StartedMailServer;
  let stub: UserServiceStub;
  let app: INestApplication;
  let relay: OutboxRelay;
  let queue: Queue;
  let dlq: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  const deadLetters = () => dlq.getJobs(['waiting', 'prioritized']) as Promise<Job<DeadLetterJob>[]>;

  const publishRefunded = async (userId: string): Promise<string> => {
    const [row] = await db
      .insert(schema.outbox)
      .values({
        id: testId(),
        aggregateType: 'Order',
        aggregateId: ORDER_ID,
        eventType: ORDER_REFUNDED_EVENT,
        payload: refundedPayload(userId),
      })
      .returning();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    return jobIdFor(row.id);
  };

  beforeAll(async () => {
    mail = await startMailServer();
    stub = await userServiceStub();
    ({ app, pool, db } = await createTestAppWithPool({
      SMTP_URL: mail.smtpUrl,
      MAIL_FROM,
      MAIL_TIMEOUT_MS,
      QUEUE_WORKER_ENABLED: 'true',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: String(BACKOFF_MS),
      ORDER_PAID_CONSUMER_ATTEMPTS: String(LONG_LADDER_ATTEMPTS),
      ORDER_PAID_CONSUMER_BACKOFF_CAP_MS: String(LONG_LADDER_CAP_MS),
      // Shorter than every rung, so an open breaker lets each retry through as its trial call.
      BREAKER_RESET_TIMEOUT_MS: '100',
    }));
    relay = app.get(OutboxRelay);
    queue = app.get<Queue>(queueToken(ORDER_EVENTS_QUEUE));
    dlq = app.get<Queue>(queueToken(ORDER_EVENTS_DLQ));
  }, 180_000);

  afterAll(async () => {
    stub?.reset();
    await app?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    stub.reset();
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    await dlq.obliterate({ force: true });
    await mail.clear();
  });

  it('rides out a user-service outage the default ladder would have dead-lettered, then mails once', async () => {
    const { user } = await createTestPrincipal(app);
    stub.fail('summary', 503);

    const jobId = await publishRefunded(user.id);
    await vi.waitFor(
      async () => expect((await queue.getJob(jobId))?.attemptsMade ?? 0).toBeGreaterThanOrEqual(ATTEMPTS),
      {
        timeout: 15_000,
        interval: 25,
      },
    );
    expect(await deadLetters()).toHaveLength(0);

    stub.reset();

    const [delivered] = await mail.waitForMail(user.email);
    expect(delivered.Subject).toBe('Your refund has been issued');
    expect(await mail.messages()).toHaveLength(1);
    expect(await deadLetters()).toHaveLength(0);
  });
});
