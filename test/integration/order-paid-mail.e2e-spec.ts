import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';
import * as userSchema from '@user/database/schema';
import { MAIL_TRANSPORT, SmtpMailTransport } from '@shared/mail';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '@shared/messaging/queue/domain-event.processor';
import { createRealTestUser } from '../setup/fixtures/user.fixture';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp, createUserApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-order-mail-metrics-token';
const MAIL_FROM = 'no-reply@jcool.test';
const MESSAGE_ID = '0198f0d8-4444-7000-8000-000000000001';
const ABSENT_ORDER_ID = '0198f0d8-6666-8000-8000-000000000001';
const USER_ID = '0198f0d8-7777-8000-8000-000000000001';
// Above the shipped 10s, below the 25s ceiling: on a cold runner the first connection through a
// freshly started container can outlast it, and abandoning that send would fail the delivery this
// suite is about.
const MAIL_TIMEOUT_MS = '20000';

const paidJob = (orderId: string, overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
  outboxId: MESSAGE_ID,
  aggregateType: 'Order',
  aggregateId: orderId,
  eventType: 'order.paid',
  payload: { orderId, userId: USER_ID, totalAmountMinor: 150_000, currency: 'VND' },
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

  // No user row anywhere in this suite: the handler resolves the recipient from the order alone.
  async function seedPaidOrder(buyerEmail: string, userId = USER_ID): Promise<string> {
    const [row] = await db
      .insert(schema.orders)
      .values({
        userId,
        buyerEmail,
        status: 'PAID',
        currency: 'VND',
        totalAmount: 150_000,
        placedAt: new Date(),
      })
      .returning({ id: schema.orders.id });
    return row.id;
  }

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

  // commerce-core still sends this mail, so it still needs MAIL_*/SMTP_URL. Were they to become
  // user-service's alone, this app would fall back to the log sink: every confirmation would stop
  // arriving and no boot, metric or log line would say so.
  it('resolves a real SMTP transport rather than the log sink', () => {
    expect(app.get(MAIL_TRANSPORT)).toBeInstanceOf(SmtpMailTransport);
  });

  it('confirms a paid order to the address the order itself snapshotted', async () => {
    const orderId = await seedPaidOrder('buyer@jcool.test');

    await expect(processor.process(paidJob(orderId))).resolves.toBe('processed');

    const [delivered] = await mail.waitForMail('buyer@jcool.test');
    expect(delivered.Subject).toBe('Your order is confirmed');
    expect(await mail.body(delivered.ID)).toContain(orderId);
  });

  // The snapshot is the point: an order confirms to the address that made the purchase, and an
  // account change in user-service — a different app on a different database — cannot redirect a
  // confirmation for an order already placed.
  it('ignores a later change to the buyer’s account email', async () => {
    const userApp = await createUserApp();
    const userPool = userApp.get<Pool>(PG_POOL);
    try {
      const { user } = await createRealTestUser(userApp, { email: 'at-checkout@jcool.test' });
      const orderId = await seedPaidOrder(user.email, user.id);
      await userApp
        .get<DrizzleDB>(DRIZZLE)
        .update(userSchema.users)
        .set({ email: 'moved-on@jcool.test' })
        .where(eq(userSchema.users.id, user.id));

      await expect(processor.process(paidJob(orderId))).resolves.toBe('processed');

      const [delivered] = await mail.waitForMail('at-checkout@jcool.test');
      expect(delivered.Subject).toBe('Your order is confirmed');
      expect(await mail.messages()).toHaveLength(1);
    } finally {
      // beforeEach resets core's database only; this suite is the sole writer to the user one.
      await resetDatabase(userPool);
      await userApp.close();
    }
  });

  it('sends nothing a second time when the message is redelivered', async () => {
    const orderId = await seedPaidOrder('buyer@jcool.test');

    await expect(processor.process(paidJob(orderId))).resolves.toBe('processed');
    await mail.waitForMail('buyer@jcool.test');
    // A fresh job id for the same message, which is what a BullMQ retry looks like from here.
    await expect(processor.process(paidJob(orderId))).resolves.toBe('duplicate');

    // No polling needed: process() awaits the post-commit effect, so a second send would already
    // have happened by now. The claim is what stops it — the duplicate never reaches a handler.
    expect(await mail.messages()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('refuses permanently when the event names an order that no longer exists', async () => {
    await expect(processor.process(paidJob(ABSENT_ORDER_ID))).rejects.toThrow(/no longer exists/);

    // The claim rolled back with the failed handler, so nothing is deduped away on a redelivery.
    expect(await inboxRows()).toHaveLength(0);
  });

  // The at-most-once half of the design: the message is applied, the mail is lost, and the loss is
  // a metric rather than a retry — because the redelivery a retry would trigger can only find its
  // own claim and do nothing.
  it('keeps a message applied when the mail cannot be delivered, and does not retry it', async () => {
    const orderId = await seedPaidOrder('buyer@jcool.test');
    const broken = await createTestApp({ SMTP_URL: UNREACHABLE_SMTP_URL, MAIL_FROM, METRICS_TOKEN });
    try {
      await expect(broken.get(DomainEventProcessor).process(paidJob(orderId))).resolves.toBe('processed');

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
