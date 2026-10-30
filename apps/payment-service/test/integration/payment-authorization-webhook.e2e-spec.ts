import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPaymentAuthorizedPayload } from '@jcool/internal-contracts/events/payment-authorized';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import {
  PAYMENT_PARTICIPANT,
  type OpenSessionInput,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { orderEventsQueue, relayOutbox } from '../setup/order-events';
import { checkoutSessionCompleted, checkoutSessionExpired, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_authorization_secret_01';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };

describe('Payment authorization webhook (integration, real Postgres, real HMAC, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [orderEventsQueue(app)]);

  const sessionInput = (): OpenSessionInput => ({
    orderId: testId(),
    ...CHARGE,
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
  });

  async function opened(input = sessionInput()) {
    const result = await participant.openSession(input);
    if (result.outcome !== 'OPENED') throw new Error(`expected OPENED, got ${result.outcome}`);
    return { input, orderId: input.orderId, paymentId: result.paymentId, sessionId: result.providerSessionId };
  }

  // Under manual capture the session completes unpaid; only the intent Stripe is asked about shows the hold.
  const completed = (sessionId: string, eventId: string) =>
    signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, { ...CHARGE, paymentStatus: 'unpaid' }, { eventId }),
    });
  const expired = (sessionId: string, eventId: string) =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId }) });

  const authorizedEvents = () =>
    db.select().from(schema.outbox).where(eq(schema.outbox.eventType, 'payment.authorized'));
  const webhookRows = () => db.select().from(schema.webhookEvents);

  it('records the hold once, and the event is consumed without a dead letter', async () => {
    const { orderId, paymentId, sessionId } = await opened();
    gateway.authorize(sessionId);

    const res = await postWebhook(app, completed(sessionId, 'evt_auth_1'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect(await readPayment(app, orderId)).toMatchObject({
      status: 'AUTHORIZED',
      providerIntentId: gateway.intentOf(sessionId),
    });
    const header = await readPaymentOrder(app, orderId);
    expect(header).toMatchObject({ status: 'AUTHORIZED', authorizedAt: expect.any(Date) });
    const [event, ...rest] = await authorizedEvents();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      aggregateType: 'Payment',
      aggregateId: paymentId,
      payload: { paymentId, orderId, ...CHARGE, authorizedAt: header.authorizedAt?.toISOString() },
    });
    // The api's handler dead-letters a payload off the contract on its first attempt.
    const jobs = await relayOutbox(app);
    expect(jobs.map((job) => [job.name, job.data.outboxId])).toEqual([['payment.authorized', event.id]]);
    expect(isPaymentAuthorizedPayload(jobs[0].data.payload)).toBe(true);
  });

  it('answers a redelivery as a duplicate and emits nothing more', async () => {
    const { sessionId } = await opened();
    gateway.authorize(sessionId);
    await postWebhook(app, completed(sessionId, 'evt_auth_1')).expect(200);

    const res = await postWebhook(app, completed(sessionId, 'evt_auth_1'));

    expect(res.body).toEqual({ status: 'duplicate' });
    expect(await authorizedEvents()).toHaveLength(1);
  });

  it('skips a completed session whose money is still clearing', async () => {
    const { orderId, sessionId } = await opened();
    gateway.authorize(sessionId, { intentStatus: 'processing' });

    const res = await postWebhook(app, completed(sessionId, 'evt_processing'));

    expect(res.body).toEqual({ status: 'skipped' });
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'PENDING' });
    expect(await authorizedEvents()).toEqual([]);
  });

  it('answers 503 and logs nothing while Stripe cannot be asked, then takes the redelivery', async () => {
    const { orderId, sessionId } = await opened();
    gateway.authorize(sessionId);
    gateway.failPaymentStatus(sessionId);

    await postWebhook(app, completed(sessionId, 'evt_outage')).expect(503);
    expect(await webhookRows()).toEqual([]);

    gateway.restorePaymentStatus(sessionId);
    await postWebhook(app, completed(sessionId, 'evt_outage')).expect(200, { status: 'processed' });
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
  });

  it('records nothing for a hold that is not the order total', async () => {
    const { orderId, sessionId } = await opened();
    gateway.authorize(sessionId, { amountMinor: CHARGE.amountMinor - 1 });

    const res = await postWebhook(app, completed(sessionId, 'evt_wrong_amount'));

    expect(res.body).toEqual({ status: 'skipped' });
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'PENDING' });
    expect(await authorizedEvents()).toEqual([]);
  });

  // The cancel flipped the header but its void never landed; the buyer's money is real.
  it('records a hold that arrives after the cancel, leaving the header cancelled', async () => {
    const { orderId, sessionId } = await opened();
    const intentId = gateway.authorize(sessionId);
    gateway.failVoid(intentId, 'idempotency_in_flight');
    await expect(participant.cancel({ orderId })).rejects.toThrow();

    await postWebhook(app, completed(sessionId, 'evt_late')).expect(200, { status: 'processed' });
    await postWebhook(app, completed(sessionId, 'evt_late_again')).expect(200);

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED', authorizedAt: expect.any(Date) });
    expect(await authorizedEvents()).toHaveLength(1);
  });

  it('voids a hold on a retired attempt and emits nothing for it', async () => {
    const first = await opened();
    gateway.lapseSession(first.sessionId);
    const replacement = await participant.openSession(first.input);
    expect(replacement).toMatchObject({ outcome: 'OPENED' });
    const strayIntent = gateway.authorize(first.sessionId);

    const res = await postWebhook(app, completed(first.sessionId, 'evt_stray'));

    expect(res.body).toEqual({ status: 'skipped' });
    expect(gateway.wasVoided(strayIntent)).toBe(true);
    expect(await authorizedEvents()).toEqual([]);
    expect(await readPaymentOrder(app, first.orderId)).toMatchObject({ status: 'OPEN', authorizedAt: null });
  });

  it('expires the attempt of a session Stripe let lapse, without an event', async () => {
    const { orderId, sessionId } = await opened();
    gateway.lapseSession(sessionId);

    await postWebhook(app, expired(sessionId, 'evt_lapsed')).expect(200, { status: 'processed' });

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'OPEN' });
  });

  it('takes the expiry notice of a session the cancel already closed', async () => {
    const { orderId, sessionId } = await opened();
    await expect(participant.cancel({ orderId })).resolves.toBe('CANCELLED');

    await postWebhook(app, expired(sessionId, 'evt_cancelled')).expect(200);

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(await relayOutbox(app)).toEqual([]);
  });
});
