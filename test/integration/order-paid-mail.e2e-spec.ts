import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-order-mail-metrics-token';
const MAIL_FROM = 'no-reply@jcool.test';
const MESSAGE_ID = '0198f0d8-4444-7000-8000-000000000001';
const ORDER_ID = '0198f0d8-5555-7000-8000-000000000001';
// Above the shipped 10s, below the 25s ceiling: on a cold runner the first connection through a
// freshly started container can outlast it, and abandoning that send would fail the delivery this
// suite is about.
const MAIL_TIMEOUT_MS = '20000';

const paidJob = (userId: string, overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
  outboxId: MESSAGE_ID,
  aggregateType: 'Order',
  aggregateId: ORDER_ID,
  eventType: 'order.paid',
  payload: { orderId: ORDER_ID, userId, totalAmountMinor: 150_000, currency: 'VND' },
  occurredAt: new Date().toISOString(),
  traceparent: null,
  ...overrides,
});

/**
 * The buyer's confirmation: an effect that leaves the database, driven by an event that arrives
 * at-least-once. Deliveries are made by hand — the worker is off in e2e — so each one is a
 * deliberate step rather than something a background tick did between assertions.
 */
describe('Order confirmation mail (integration, real Mailpit + Postgres + Redis)', () => {
  let mail: StartedMailServer;
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let db: DrizzleDB;
  let pool: Pool;

  const inboxRows = () => db.select().from(schema.inbox);

  beforeAll(async () => {
    mail = await startMailServer();
    app = await createTestApp({ SMTP_URL: mail.smtpUrl, MAIL_FROM, METRICS_TOKEN, MAIL_TIMEOUT_MS });
    processor = app.get(DomainEventProcessor);
    db = app.get<DrizzleDB>(DRIZZLE);
    pool = app.get<Pool>(PG_POOL);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await mail.clear();
  });

  it('confirms a paid order to the address the event only names by id', async () => {
    const { user } = await createTestUser(app);

    await expect(processor.process(paidJob(user.id))).resolves.toBe('processed');

    const [delivered] = await mail.waitForMail(user.email);
    expect(delivered.Subject).toBe('Your order is confirmed');
    expect(await mail.body(delivered.ID)).toContain(ORDER_ID);
  });

  it('sends nothing a second time when the message is redelivered', async () => {
    const { user } = await createTestUser(app);

    await expect(processor.process(paidJob(user.id))).resolves.toBe('processed');
    await mail.waitForMail(user.email);
    // A fresh job id for the same message, which is what a BullMQ retry looks like from here.
    await expect(processor.process(paidJob(user.id))).resolves.toBe('duplicate');

    // No polling needed: process() awaits the post-commit effect, so a second send would already
    // have happened by now. The claim is what stops it — the duplicate never reaches a handler.
    expect(await mail.messages()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('refuses permanently when the event names a user that no longer exists', async () => {
    await expect(processor.process(paidJob('0198f0d8-6666-8000-8000-000000000001'))).rejects.toThrow(
      /no longer exists/,
    );

    // The claim rolled back with the failed handler, so nothing is deduped away on a redelivery.
    expect(await inboxRows()).toHaveLength(0);
  });

  // The at-most-once half of the design: the message is applied, the mail is lost, and the loss is
  // a metric rather than a retry — because the redelivery a retry would trigger can only find its
  // own claim and do nothing.
  it('keeps a message applied when the mail cannot be delivered, and does not retry it', async () => {
    const { user } = await createTestUser(app);
    const broken = await createTestApp({ SMTP_URL: UNREACHABLE_SMTP_URL, MAIL_FROM, METRICS_TOKEN });
    try {
      await expect(broken.get(DomainEventProcessor).process(paidJob(user.id))).resolves.toBe('processed');

      // `resolves.toBe('processed')` above is the whole proof: the dead-letter queue is written by
      // the worker's 'failed' listener, and a consume that never fails never reaches it.
      expect(await inboxRows()).toHaveLength(1);
      expect(await mail.messages()).toHaveLength(0);

      const { text } = await request(broken.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .expect(200);
      expect(text).toMatch(/mail_send_failures_total\{kind="order_paid"\} [1-9]/);
      // Applied, not failed: a failed consume here would mean the queue still owes a redelivery.
      expect(text).toContain('messaging_consume_total{event_type="order.paid",result="processed"}');
    } finally {
      await broken.close();
    }
  });
});
