import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { ConsumerRetryRow } from '../../src/shared/messaging/retry/consumer-retry.store';
import { cappedBackoffMs, retryHorizonMs } from '../../src/shared/messaging/retry/retry-policy';
import { createTestPrincipal, mintTestUserId } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { startMailServer, type StartedMailServer } from '../setup/mail-server';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';
import { type UserServiceStub, userServiceStub } from '../setup/user-service-stub';
import { testId } from '../setup/id-service-stub';

const MAIL_FROM = 'no-reply@jcool.test';
const MAIL_TIMEOUT_MS = '20000';
const ORDER_ID = testId();

// Scaled down from ~2 min against ~33 min. The order is what production relies on: the default
// ladder is spent well inside order.paid's.
const ATTEMPTS = 3;
const BACKOFF_MS = 100;
const ORDER_PAID_ATTEMPTS = 8;
const ORDER_PAID_CAP_MS = 400;
const ORDER_PAID_HORIZON_MS = retryHorizonMs(ORDER_PAID_ATTEMPTS, (n) =>
  cappedBackoffMs(n, BACKOFF_MS, ORDER_PAID_CAP_MS),
);
// The same attempts with the doubling left uncapped: dead-lettering before this proves the cap applied.
const UNCAPPED_HORIZON_MS = retryHorizonMs(ORDER_PAID_ATTEMPTS, (n) => BACKOFF_MS * 2 ** (n - 1));

/**
 * The buyer's address comes from the user-service, so its outages reach the consumer. The claim is
 * that order.paid outlasts them on a ladder of its own, published by the real relay, and only
 * dead-letters once that longer ladder is spent.
 */
describe('Order confirmation mail against the user directory (integration, real Mailpit + Postgres + Redis)', () => {
  let mail: StartedMailServer;
  let stub: UserServiceStub;
  let app: INestApplication;
  let relay: OutboxRelay;
  let db: DrizzleDB;
  let pool: Pool;

  const inboxRows = () => db.select().from(schema.inbox);
  const deadLetters = () => db.select().from(schema.consumerRetries).where(eq(schema.consumerRetries.status, 'dead'));
  const retryRowFor = async (messageId: string): Promise<ConsumerRetryRow | undefined> =>
    (await db.select().from(schema.consumerRetries).where(eq(schema.consumerRetries.messageId, messageId)))[0];
  // An attempt is charged when it is leased, so one still holding the lease has not failed yet.
  const failedAttempts = (row: ConsumerRetryRow | undefined) =>
    row ? row.attemptsMade - (row.leaseToken === null ? 0 : 1) : 0;

  const publishPaid = async (userId: string): Promise<string> => {
    const [row] = await db
      .insert(schema.outbox)
      .values({
        id: testId(),
        aggregateType: 'Order',
        aggregateId: ORDER_ID,
        eventType: 'order.paid',
        payload: { orderId: ORDER_ID, userId, totalAmountMinor: 150_000, currency: 'VND' },
      })
      .returning();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    return row.id;
  };

  const waitForFailedAttempts = (messageId: string, count: number) =>
    vi.waitFor(async () => expect(failedAttempts(await retryRowFor(messageId))).toBeGreaterThanOrEqual(count), {
      timeout: 15_000,
      interval: 25,
    });

  beforeAll(async () => {
    mail = await startMailServer();
    stub = await userServiceStub();
    ({ app, pool, db } = await createTestAppWithPool({
      SMTP_URL: mail.smtpUrl,
      MAIL_FROM,
      MAIL_TIMEOUT_MS,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      QUEUE_WORKER_ENABLED: 'true',
      MESSAGING_RETRY_ENABLED: 'true',
      MESSAGING_RETRY_POLL_MS: '100',
      QUEUE_CONSUMER_ATTEMPTS: String(ATTEMPTS),
      QUEUE_CONSUMER_BACKOFF_MS: String(BACKOFF_MS),
      ORDER_PAID_CONSUMER_ATTEMPTS: String(ORDER_PAID_ATTEMPTS),
      ORDER_PAID_CONSUMER_BACKOFF_CAP_MS: String(ORDER_PAID_CAP_MS),
      // Shorter than every rung, so an open breaker lets each retry through as its trial call.
      BREAKER_RESET_TIMEOUT_MS: '100',
    }));
    relay = app.get(OutboxRelay);
  }, 180_000);

  afterAll(async () => {
    stub?.reset();
    await app?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    stub.reset();
    await resetDatabase(pool);
    await mail.clear();
  });

  it('confirms to the address the user-service holds', async () => {
    const { user } = await createTestPrincipal(app);

    await publishPaid(user.id);

    const [delivered] = await mail.waitForMail(user.email);
    expect(delivered.Subject).toBe('Your order is confirmed');
    expect(stub.calls('summary')).toBeGreaterThanOrEqual(1);
  });

  it('rides out an outage the default ladder would have dead-lettered', async () => {
    const { user } = await createTestPrincipal(app);
    stub.fail('summary', 503);

    const messageId = await publishPaid(user.id);
    await waitForFailedAttempts(messageId, ATTEMPTS);
    expect(await deadLetters()).toHaveLength(0);

    stub.reset();

    await mail.waitForMail(user.email);
    expect(await inboxRows()).toHaveLength(1);
    expect(await deadLetters()).toHaveLength(0);
  });

  it('cuts a user-service that never answers at the client timeout, and retries', async () => {
    const { user } = await createTestPrincipal(app);
    stub.fail('summary', 'hang');

    const messageId = await publishPaid(user.id);
    await waitForFailedAttempts(messageId, 1);

    stub.reset();

    await mail.waitForMail(user.email);
  });

  it('retries a buyer the directory has not copied yet, then confirms', async () => {
    const email = `late-${Date.now()}@test.local`;
    const user = { id: mintTestUserId(), email, role: 'CUSTOMER' as const };

    const messageId = await publishPaid(user.id);
    await waitForFailedAttempts(messageId, 2);
    expect(await deadLetters()).toHaveLength(0);

    stub.register(user);

    await mail.waitForMail(user.email);
  });

  it('dead-letters only once the order.paid ladder is spent', async () => {
    const { user } = await createTestPrincipal(app);
    stub.fail('summary', 503);
    const publishedAt = Date.now();

    await publishPaid(user.id);

    let dead: ConsumerRetryRow | undefined;
    await vi.waitFor(
      async () => {
        [dead] = await deadLetters();
        expect(dead).toBeDefined();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(dead?.attemptsMade).toBe(ORDER_PAID_ATTEMPTS);
    expect(dead?.deadReason).toBe('attempts_exhausted');
    const elapsedMs = (dead?.lastFailedAt.getTime() ?? 0) - publishedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(ORDER_PAID_HORIZON_MS);
    expect(elapsedMs).toBeLessThan(UNCAPPED_HORIZON_MS);
    expect(await inboxRows()).toHaveLength(0);
    expect(await mail.messages()).toHaveLength(0);

    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    expect(text).toContain('messaging_dlq_total{event_type="order.paid",reason="attempts_exhausted"} 1');
  });
});
