import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { manualSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_payment_participant_secret_01';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';

describe('Payment participant (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let order: string;
  let expiresAt: Date;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      RECONCILE_ENABLED: 'false',
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    }));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(() => {
    order = testId();
    expiresAt = new Date(Date.now() + 60 * 60_000);
  });

  const open = (orderId = order) =>
    participant.openSession({ orderId, amountMinor: AMOUNT_MINOR, currency: CURRENCY, expiresAt });

  async function opened(orderId = order): Promise<string> {
    const result = await open(orderId);
    if (result.outcome !== 'OPENED') throw new Error(`expected an open session, got ${result.outcome}`);
    return result.providerSessionId;
  }

  /** The buyer pays and Stripe's webhook records the hold, as in production. */
  async function authorized(): Promise<{ paymentId: string; intentId: string }> {
    const sessionId = await opened();
    const intentId = gateway.authorize(sessionId);
    const event = manualSessionCompleted(
      sessionId,
      { amountMinor: AMOUNT_MINOR, currency: CURRENCY },
      {
        eventId: `evt_${testId()}`,
      },
    );
    await postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event })).expect(200);
    const payment = await readPayment(app, order);
    expect(payment.status).toBe('AUTHORIZED');
    return { paymentId: payment.id, intentId };
  }

  it('opens a manual-capture session under an OPEN header, closing it by the deadline it was given', async () => {
    const sessionId = await opened();

    expect(await readPaymentOrder(app, order)).toMatchObject({
      status: 'OPEN',
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
    });
    expect(await readPayment(app, order)).toMatchObject({ status: 'PENDING', providerSessionId: sessionId });
    expect(gateway.sessionRequest(sessionId)).toMatchObject({ captureMethod: 'manual', expiresAt });
  });

  it('hands back the open session to a repeated open', async () => {
    const sessionId = await opened();

    expect(await open()).toMatchObject({ outcome: 'OPENED', providerSessionId: sessionId });
  });

  it('fences an order cancelled before any open, so a late open is refused', async () => {
    expect(await participant.cancel(order)).toEqual({ outcome: 'FENCED' });

    expect(await readPaymentOrder(app, order)).toMatchObject({ status: 'FENCED', amountMinor: null, currency: null });
    expect(await open()).toEqual({ outcome: 'CLOSED' });
  });

  it('refuses a header without money unless it is fenced', async () => {
    await expect(
      pool.query(`INSERT INTO payment_orders (order_id, status) VALUES ($1, 'OPEN')`, [testId()]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_payment_orders_amount_when_not_fenced' });
  });

  it('refuses to capture an order whose buyer has not paid yet', async () => {
    await opened();

    expect(await participant.capture(order)).toEqual({ outcome: 'NOT_CAPTURABLE' });
  });

  it('captures a hold once, however often the capture arrives', async () => {
    const { intentId } = await authorized();

    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });

    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await readPayment(app, order)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await readPaymentOrder(app, order)).status).toBe('CAPTURED');
  });

  // Nothing came back, so nothing is known; Stripe has stored nothing under the key either.
  it('keeps the key after a capture that timed out, and the retry captures under it', async () => {
    const { paymentId, intentId } = await authorized();
    gateway.failCapture(intentId, 'timeout');

    await expect(participant.capture(order)).rejects.toThrow();
    expect(await readPayment(app, order)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 0 });

    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(gateway.requestKeys(intentId)).toEqual([`capture:${paymentId}:0`, `capture:${paymentId}:0`]);
    expect(gateway.captureCalls(intentId)).toBe(1);
  });

  // Stripe replays a stored 500 for every resend of its key; only a new key gets past it.
  it('rotates the key after a 500 that left the hold capturable, and the retry captures under the new one', async () => {
    const { paymentId, intentId } = await authorized();
    gateway.failCapture(intentId, 'server_error');

    await expect(participant.capture(order)).rejects.toThrow();
    expect(await readPayment(app, order)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 1 });

    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(gateway.requestKeys(intentId)).toEqual([`capture:${paymentId}:0`, `capture:${paymentId}:1`]);
    expect(gateway.captureCalls(intentId)).toBe(1);
  });

  it('reads a 500 that followed an applied capture as captured, without a second capture', async () => {
    const { intentId } = await authorized();
    gateway.failCapture(intentId, 'applied_then_500');

    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await readPayment(app, order)).toMatchObject({ status: 'SUCCEEDED', stripeKeyGen: 0 });
  });

  // The 409 means another request under the same key is still running, and may yet capture.
  it('leaves a capture whose key is still in flight unknown, and the retry captures under the same key', async () => {
    const { paymentId, intentId } = await authorized();
    gateway.failCapture(intentId, 'idempotency_in_flight');

    await expect(participant.capture(order)).rejects.toThrow();
    expect(await readPayment(app, order)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 0 });

    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(gateway.requestKeys(intentId)).toEqual([`capture:${paymentId}:0`, `capture:${paymentId}:0`]);
  });

  it('fails the payment and cancels the header when the authorization lapsed', async () => {
    const { intentId } = await authorized();
    gateway.failCapture(intentId, 'expired');

    expect(await participant.capture(order)).toEqual({ outcome: 'NOT_CAPTURABLE' });
    expect((await readPayment(app, order)).status).toBe('FAILED');
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
  });

  it('voids an authorized hold on cancel', async () => {
    const { intentId } = await authorized();

    expect(await participant.cancel(order)).toEqual({ outcome: 'CANCELLED' });
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect((await readPayment(app, order)).status).toBe('VOIDED');
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
  });

  it('rotates the void key after a 500, with the header already closed, and the retry voids', async () => {
    const { paymentId, intentId } = await authorized();
    gateway.failVoid(intentId, 'server_error');

    await expect(participant.cancel(order)).rejects.toThrow();
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
    expect(await readPayment(app, order)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 1 });

    expect(await participant.cancel(order)).toEqual({ outcome: 'CANCELLED' });
    expect(gateway.requestKeys(intentId)).toEqual([`void:${paymentId}:0`, `void:${paymentId}:1`]);
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect((await readPayment(app, order)).status).toBe('VOIDED');
  });

  it('reads a 500 that followed an applied void as voided', async () => {
    const { intentId } = await authorized();
    gateway.failVoid(intentId, 'applied_then_500');

    expect(await participant.cancel(order)).toEqual({ outcome: 'CANCELLED' });
    expect(await readPayment(app, order)).toMatchObject({ status: 'VOIDED', stripeKeyGen: 0 });
  });

  it('raises the conflict alarm for a cancel that arrives after the capture', async () => {
    await authorized();
    await participant.capture(order);

    expect(await participant.cancel(order)).toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect((await readPayment(app, order)).status).toBe('SUCCEEDED');
    expect(await captureConflicts()).toBeGreaterThan(0);
  });

  // Both reach Stripe under one key before either records; the second is a repeat, not a refund case.
  it('records overlapping captures of one hold once, without the conflict alarm', async () => {
    const { paymentId, intentId } = await authorized();
    const alarmsBefore = await captureConflicts();

    const results = await Promise.all([participant.capture(order), participant.capture(order)]);

    expect(results).toEqual([{ outcome: 'CAPTURED' }, { outcome: 'CAPTURED' }]);
    expect(gateway.requestKeys(intentId)).toEqual([`capture:${paymentId}:0`, `capture:${paymentId}:0`]);
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect((await readPaymentOrder(app, order)).status).toBe('CAPTURED');
    expect(await captureConflicts()).toBe(alarmsBefore);
  });

  // The header stays CANCELLED, so a retry that read only the header would report a clean cancel.
  it('keeps reporting money taken under a cancelled header to every retry', async () => {
    const { intentId } = await authorized();
    gateway.setIntentStatus(intentId, 'succeeded');

    expect(await participant.cancel(order)).toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
    expect((await readPayment(app, order)).status).toBe('SUCCEEDED');

    expect(await participant.cancel(order)).toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect(await participant.capture(order)).toEqual({ outcome: 'CAPTURED' });
    expect(gateway.captureCalls(intentId)).toBe(0);
  });

  async function captureConflicts(): Promise<number> {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    return Number(/^payment_capture_conflict_total (\d+)/m.exec(text)?.[1] ?? 0);
  }
});
