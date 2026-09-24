import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { createTestPrincipal, mintTestUserId } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const MAIL_FROM = 'no-reply@jcool.test';
const MESSAGE_ID = '0198f0d8-4444-7000-8000-000000000001';
const ORDER_ID = '0198f0d8-5555-7000-8000-000000000001';
// Above the shipped 10s: a cold container's first SMTP connection can outlast it.
const MAIL_TIMEOUT_MS = '20000';
// Past the directory's grace window, where an unknown user reads as gone rather than not yet copied.
const LONG_AGO = new Date(Date.now() - 24 * 3_600_000).toISOString();

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

// Deliveries are driven by hand; the queue worker is off in e2e.
describe('Order confirmation mail (integration, real Mailpit + Postgres + Redis)', () => {
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

  it('confirms a paid order once, however often the message is redelivered', async () => {
    const { user } = await createTestPrincipal(app);

    await expect(processor.process(paidJob(user.id))).resolves.toBe('processed');
    const [delivered] = await mail.waitForMail(user.email);
    await expect(processor.process(paidJob(user.id))).resolves.toBe('duplicate');

    expect(delivered.Subject).toBe('Your order is confirmed');
    expect(await mail.body(delivered.ID)).toContain(ORDER_ID);
    // process() awaits the post-commit effect, so a second send would already be here.
    expect(await mail.messages()).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('refuses permanently when the event names a user that no longer exists', async () => {
    await expect(
      processor.process(paidJob(mintTestUserId('gone@test.local'), { occurredAt: LONG_AGO })),
    ).rejects.toThrow(/no longer exists/);

    expect(await inboxRows()).toHaveLength(0);
  });

  // A retry would only find its own claim, so a lost mail is counted instead of retried.
  it('keeps a message applied when the mail cannot be delivered, and does not retry it', async () => {
    const { user } = await createTestPrincipal(app);
    const broken = await createTestApp({
      SMTP_URL: UNREACHABLE_SMTP_URL,
      MAIL_FROM,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    });
    try {
      await expect(broken.get(DomainEventProcessor).process(paidJob(user.id))).resolves.toBe('processed');

      expect(await inboxRows()).toHaveLength(1);
      expect(await mail.messages()).toHaveLength(0);

      const { text } = await request(broken.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
      expect(text).toMatch(/mail_send_failures_total\{kind="order_paid"\} [1-9]/);
      expect(text).toContain('messaging_consume_total{event_type="order.paid",result="processed"}');
    } finally {
      await broken.close();
    }
  });
});
