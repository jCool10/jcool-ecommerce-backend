import type { INestApplication } from '@nestjs/common';
import { eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPaymentAuthorizedPayload } from '@jcool/internal-contracts/events/payment-authorized';
import { ORDER_PAID_BACKOFF } from '@jcool/internal-contracts/queues/order-events';
import { jobIdFor } from '@jcool/messaging';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { eventually } from '../setup/eventually';
import { postWebhook } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { orderEventsQueue, queuedOrderEvents } from '../setup/order-events';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_authorized_publish_0001';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };
const ORDER_PAID_ATTEMPTS = 12;
const POLL_MS = 100;

// The relay runs on its own timer here, the way it does in production.
describe('Authorized event publish (integration, real Postgres, real Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      ORDER_PAID_CONSUMER_ATTEMPTS: String(ORDER_PAID_ATTEMPTS),
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_MS: String(POLL_MS),
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [orderEventsQueue(app)]);

  async function authorizedSession() {
    const orderId = testId();
    const session = await app.get<PaymentParticipant>(PAYMENT_PARTICIPANT).openSession({
      orderId,
      ...CHARGE,
      expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
    });
    if (session.outcome !== 'OPENED') throw new Error(`expected OPENED, got ${session.outcome}`);
    gateway.authorize(session.providerSessionId);
    return { orderId, sessionId: session.providerSessionId };
  }

  const completed = (sessionId: string, eventId: string) =>
    signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, { ...CHARGE, paymentStatus: 'unpaid' }, { eventId }),
    });

  const authorizedRows = () => db.select().from(schema.outbox).where(eq(schema.outbox.eventType, 'payment.authorized'));
  const unpublishedRows = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
  const queuedOnce = () =>
    eventually(
      () => queuedOrderEvents(app),
      (jobs) => jobs.length > 0,
    );

  it('puts payment.authorized on order-events once, on the ladder the api consumer expects', async () => {
    const { orderId, sessionId } = await authorizedSession();

    await postWebhook(app, completed(sessionId, 'evt_publish_1')).expect(200, { status: 'processed' });

    const jobs = await queuedOnce();
    const [row] = await authorizedRows();
    expect(jobs.map((job) => [job.name, job.id])).toEqual([['payment.authorized', jobIdFor(row.id)]]);
    const [job] = jobs;
    expect(job.data).toMatchObject({ outboxId: row.id, eventType: 'payment.authorized', payload: row.payload });
    expect(isPaymentAuthorizedPayload(job.data.payload)).toBe(true);
    expect(job.data.payload).toMatchObject({ orderId, ...CHARGE });
    expect(job.opts.attempts).toBe(ORDER_PAID_ATTEMPTS);
    expect(job.opts.backoff).toMatchObject({ type: ORDER_PAID_BACKOFF });
  });

  it('sends one job for one hold, however often Stripe delivers it', async () => {
    const { sessionId } = await authorizedSession();
    const first = completed(sessionId, 'evt_redelivered');

    const statuses = [];
    for (const signed of [
      first,
      first,
      completed(sessionId, 'evt_resent_a'),
      first,
      completed(sessionId, 'evt_resent_b'),
    ]) {
      statuses.push((await postWebhook(app, signed).expect(200)).body.status);
    }

    expect(statuses[0]).toBe('processed');
    await eventually(unpublishedRows, (rows) => rows.length === 0);
    // A few more relay ticks: nothing left to send means nothing more is sent.
    await sleep(POLL_MS * 5);
    expect(await authorizedRows()).toHaveLength(1);
    expect((await queuedOrderEvents(app)).map((job) => job.name)).toEqual(['payment.authorized']);
  });
});
