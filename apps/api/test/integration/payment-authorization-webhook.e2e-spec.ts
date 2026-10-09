import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import {
  checkoutSessionExpired,
  manualSessionCompleted,
  signWebhook,
  type SignedWebhook,
} from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_payment_authorization_secret_01';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';

describe('Authorization webhook for a fenced payment (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let order: string;
  let sessionId: string;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, { RECONCILE_ENABLED: 'false' }));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    order = testId();
    const opened = await participant.openSession({
      orderId: order,
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    if (opened.outcome !== 'OPENED') throw new Error('expected an open session');
    sessionId = opened.providerSessionId;
  });

  const completed = (eventId: string, amountMinor = AMOUNT_MINOR): SignedWebhook =>
    signWebhook({
      secret: WEBHOOK_SECRET,
      event: manualSessionCompleted(sessionId, { amountMinor, currency: CURRENCY }, { eventId }),
    });
  const expired = (eventId: string): SignedWebhook =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId }) });

  const paymentEvents = () => db.select().from(schema.outbox).where(eq(schema.outbox.aggregateType, 'Payment'));
  const webhookRow = (eventId: string) =>
    db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.providerEventId, eventId));

  it('records the hold on the payment and the header, and announces it once', async () => {
    const intentId = gateway.authorize(sessionId);

    const res = await postWebhook(app, completed('evt_auth_1')).expect(200);

    expect(res.body).toEqual({ status: 'processed' });
    const payment = await readPayment(app, order);
    expect(payment).toMatchObject({ status: 'AUTHORIZED', providerIntentId: intentId });
    expect(payment.authorizedAt).not.toBeNull();
    expect((await readPaymentOrder(app, order)).status).toBe('AUTHORIZED');
    const [event, ...rest] = await paymentEvents();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      aggregateId: payment.id,
      eventType: 'payment.authorized',
      payload: {
        paymentId: payment.id,
        orderId: order,
        amountMinor: AMOUNT_MINOR,
        currency: CURRENCY,
        authorizedAt: payment.authorizedAt!.toISOString(),
      },
    });
  });

  it('answers a redelivery as a duplicate without announcing twice', async () => {
    gateway.authorize(sessionId);
    await postWebhook(app, completed('evt_auth_dup')).expect(200);

    const res = await postWebhook(app, completed('evt_auth_dup')).expect(200);

    expect(res.body).toEqual({ status: 'duplicate' });
    expect(await paymentEvents()).toHaveLength(1);
  });

  it('skips a completed session whose hold is still processing', async () => {
    gateway.setIntentStatus(gateway.authorize(sessionId), 'processing');

    const res = await postWebhook(app, completed('evt_auth_processing')).expect(200);

    expect(res.body).toEqual({ status: 'skipped' });
    expect((await readPayment(app, order)).status).toBe('PENDING');
    expect(await paymentEvents()).toHaveLength(0);
  });

  // A logged delivery would dedup Stripe's redelivery into nothing; an unlogged one is processed then.
  it('answers 503 without logging the delivery while Stripe cannot be read, and processes the redelivery', async () => {
    gateway.authorize(sessionId);
    gateway.failPaymentStatus(sessionId);

    await postWebhook(app, completed('evt_auth_outage')).expect(503);
    expect(await webhookRow('evt_auth_outage')).toHaveLength(0);

    gateway.restorePaymentStatus(sessionId);
    const res = await postWebhook(app, completed('evt_auth_outage')).expect(200);

    expect(res.body).toEqual({ status: 'processed' });
    expect((await readPayment(app, order)).status).toBe('AUTHORIZED');
  });

  it('refuses a hold for money other than the order was opened for', async () => {
    gateway.authorize(sessionId, { amountMinor: AMOUNT_MINOR + 1 });

    const res = await postWebhook(app, completed('evt_auth_mismatch', AMOUNT_MINOR + 1)).expect(200);

    expect(res.body).toEqual({ status: 'skipped' });
    expect((await readPayment(app, order)).status).toBe('PENDING');
    expect(await paymentEvents()).toHaveLength(0);
  });

  // The saga can only void a hold it hears about, so a late one is still recorded and announced.
  it('records a hold landing after the cancel closed the header, leaving the header closed', async () => {
    gateway.failExpireSession(sessionId);
    await expect(participant.cancel(order)).rejects.toThrow();
    gateway.authorize(sessionId);

    await postWebhook(app, completed('evt_auth_late')).expect(200);

    expect((await readPayment(app, order)).status).toBe('AUTHORIZED');
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
    expect((await paymentEvents()).map((e) => e.eventType)).toEqual(['payment.authorized']);
  });

  it('expires the payment when Stripe lapses the session, without moving the header or emitting', async () => {
    await gateway.expireSession(sessionId);

    const res = await postWebhook(app, expired('evt_expired_1')).expect(200);

    expect(res.body).toEqual({ status: 'processed' });
    expect((await readPayment(app, order)).status).toBe('EXPIRED');
    expect((await readPaymentOrder(app, order)).status).toBe('OPEN');
    expect(await paymentEvents()).toHaveLength(0);
  });

  // The expiry is the echo of the cancel's own close: the saga has already compensated, so it fails nothing.
  it('acknowledges the expiry Stripe sends after a cancel closed the session, emitting nothing', async () => {
    expect(await participant.cancel(order)).toEqual({ outcome: 'CANCELLED' });

    const res = await postWebhook(app, expired('evt_expired_after_cancel')).expect(200);

    expect(res.body).toEqual({ status: 'skipped' });
    expect((await readPayment(app, order)).status).toBe('EXPIRED');
    expect(await paymentEvents()).toHaveLength(0);
  });
});
