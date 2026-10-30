import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type OpenSessionInput,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { metricsAuthHeader } from '../setup/metrics.helper';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_participant_secret_0123';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };

describe('Payment participant (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const sessionInput = (orderId = testId()): OpenSessionInput => ({
    orderId,
    ...CHARGE,
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
  });

  async function opened(orderId = testId()) {
    const input = sessionInput(orderId);
    const result = await participant.openSession(input);
    if (result.outcome !== 'OPENED') throw new Error(`expected OPENED, got ${result.outcome}`);
    return { input, orderId, paymentId: result.paymentId, sessionId: result.providerSessionId };
  }

  /** The buyer pays; the next open probes the session and records the hold. */
  async function authorized(orderId = testId()) {
    const order = await opened(orderId);
    const intentId = gateway.authorize(order.sessionId);
    await expect(participant.openSession(order.input)).resolves.toEqual({ outcome: 'CLOSED' });
    return { ...order, intentId };
  }

  async function captureConflicts(): Promise<number> {
    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    const match = /^payment_capture_conflict_total (\d+)/m.exec(res.text);
    return match ? Number(match[1]) : 0;
  }

  describe('openSession', () => {
    it('opens the header and a manual-capture session, and hands the same one back while it is open', async () => {
      const input = sessionInput();

      const first = await participant.openSession(input);
      expect(first).toMatchObject({ outcome: 'OPENED' });
      expect(gateway.lastCreateSessionInput()).toMatchObject({ captureMethod: 'manual', expiresAt: input.expiresAt });
      expect(await readPaymentOrder(app, input.orderId)).toMatchObject({ status: 'OPEN', ...CHARGE });
      expect(await readPayment(app, input.orderId)).toMatchObject({ status: 'PENDING' });

      const again = await participant.openSession(input);
      expect(again).toEqual(expect.objectContaining({ outcome: 'OPENED' }));
      expect(again.outcome === 'OPENED' && again.providerSessionId).toBe(
        first.outcome === 'OPENED' && first.providerSessionId,
      );
    });

    it('fences an order cancelled before it ever opened, and every later open is closed', async () => {
      const orderId = testId();

      await expect(participant.cancel({ orderId })).resolves.toBe('FENCED');

      expect(await readPaymentOrder(app, orderId)).toMatchObject({
        status: 'FENCED',
        amountMinor: null,
        currency: null,
      });
      await expect(participant.openSession(sessionInput(orderId))).resolves.toEqual({ outcome: 'CLOSED' });
    });

    it('refuses a header without a charge unless it is fenced', async () => {
      await expect(
        pool.query(`insert into payment_orders (order_id, status) values ($1, 'OPEN')`, [testId()]),
      ).rejects.toThrow(/ck_payment_orders_amount_when_not_fenced/);
    });
  });

  describe('capture', () => {
    it('answers CONFLICT while the order is only open', async () => {
      const { orderId } = await opened();

      await expect(participant.capture({ orderId })).resolves.toBe('CONFLICT');
    });

    it('captures the hold once, however often it is asked', async () => {
      const { orderId, intentId } = await authorized();

      await expect(participant.capture({ orderId })).resolves.toBe('CAPTURED');
      await expect(participant.capture({ orderId })).resolves.toBe('IDEMPOTENT');

      expect(gateway.captureCalls(intentId)).toBe(1);
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
    });

    it('retries a capture whose answer was lost under the same key', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failCapture(intentId, 'timeout');

      await expect(participant.capture({ orderId })).rejects.toThrow();
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 0 });

      await expect(participant.capture({ orderId })).resolves.toBe('CAPTURED');
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    // Resending the key would only replay the stored 500, so this one fails unless the key rotates.
    it('rotates the key after a 5xx Stripe stored without applying', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failCapture(intentId, 'server_error');

      await expect(participant.capture({ orderId })).rejects.toThrow();
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 1 });

      await expect(participant.capture({ orderId })).resolves.toBe('CAPTURED');
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('reads a capture that landed before its 5xx as captured, keeping the key', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failCapture(intentId, 'applied_then_500');

      await expect(participant.capture({ orderId })).resolves.toBe('CAPTURED');
      expect(gateway.captureCalls(intentId)).toBe(1);
      expect(await readPayment(app, orderId)).toMatchObject({ stripeKeyGen: 0 });
    });

    it('lets a capture still in flight under the same key fail, and the retry capture', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failCapture(intentId, 'idempotency_in_flight');

      await expect(participant.capture({ orderId })).rejects.toThrow();
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });

      await expect(participant.capture({ orderId })).resolves.toBe('CAPTURED');
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('gives up on a hold that lapsed, and keeps saying so', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failCapture(intentId, 'expired');

      await expect(participant.capture({ orderId })).resolves.toBe('NOT_CAPTURABLE');
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'FAILED' });
      expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED' });

      await expect(participant.capture({ orderId })).resolves.toBe('NOT_CAPTURABLE');
    });
  });

  describe('cancel', () => {
    it('voids an authorized hold', async () => {
      const { orderId, intentId } = await authorized();

      await expect(participant.cancel({ orderId })).resolves.toBe('CANCELLED');

      expect(gateway.wasVoided(intentId)).toBe(true);
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'VOIDED' });
      expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED' });
    });

    it('rotates the void key after a stored 5xx, and the retry finishes the release', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failVoid(intentId, 'server_error');

      await expect(participant.cancel({ orderId })).rejects.toThrow();
      expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED' });
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED', stripeKeyGen: 1 });

      await expect(participant.cancel({ orderId })).resolves.toBe('IDEMPOTENT');
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'VOIDED' });
      expect(gateway.wasVoided(intentId)).toBe(true);
    });

    it('reads a void that landed before its 5xx as voided, keeping the key', async () => {
      const { orderId, intentId } = await authorized();
      gateway.failVoid(intentId, 'applied_then_500');

      await expect(participant.cancel({ orderId })).resolves.toBe('CANCELLED');
      expect(await readPayment(app, orderId)).toMatchObject({ status: 'VOIDED', stripeKeyGen: 0 });
    });

    it('reports a captured order as a conflict and counts it', async () => {
      const { orderId } = await authorized();
      await participant.capture({ orderId });
      const before = await captureConflicts();

      await expect(participant.cancel({ orderId })).resolves.toBe('CAPTURED_CONFLICT');

      expect(await captureConflicts()).toBe(before + 1);
      expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
    });
  });

  describe('statusOf', () => {
    const NOTHING = {
      header: null,
      authorizedPaymentId: null,
      hasAuthorizedAttempt: false,
      hasSucceededAttempt: false,
    };

    it('follows each order through the fence', async () => {
      const none = testId();
      const open = await opened();
      const held = await authorized();
      const captured = await authorized();
      await participant.capture({ orderId: captured.orderId });
      const voided = await authorized();
      await participant.cancel({ orderId: voided.orderId });
      const fenced = testId();
      await participant.cancel({ orderId: fenced });

      const statuses = await participant.statusOf([
        none,
        open.orderId,
        held.orderId,
        captured.orderId,
        voided.orderId,
        fenced,
      ]);

      expect(Object.fromEntries(statuses)).toEqual({
        [none]: NOTHING,
        [open.orderId]: { ...NOTHING, header: 'OPEN' },
        [held.orderId]: {
          header: 'AUTHORIZED',
          authorizedPaymentId: held.paymentId,
          hasAuthorizedAttempt: true,
          hasSucceededAttempt: false,
        },
        [captured.orderId]: {
          header: 'CAPTURED',
          authorizedPaymentId: captured.paymentId,
          hasAuthorizedAttempt: false,
          hasSucceededAttempt: true,
        },
        [voided.orderId]: { ...NOTHING, header: 'CANCELLED' },
        [fenced]: { ...NOTHING, header: 'FENCED' },
      });
    });

    // The cancel flipped the header but never reached the hold; the webhook then recorded it late.
    it('shows a hold recorded after the cancel', async () => {
      const { orderId, sessionId, paymentId } = await opened();
      const intentId = gateway.authorize(sessionId);
      gateway.failVoid(intentId, 'idempotency_in_flight');
      await expect(participant.cancel({ orderId })).rejects.toThrow();
      const completed = checkoutSessionCompleted(
        sessionId,
        { ...CHARGE, paymentStatus: 'unpaid' },
        { eventId: 'evt_late' },
      );
      await postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event: completed })).expect(200);

      const statuses = await participant.statusOf([orderId]);

      expect(statuses.get(orderId)).toEqual({
        header: 'CANCELLED',
        authorizedPaymentId: paymentId,
        hasAuthorizedAttempt: true,
        hasSucceededAttempt: false,
      });
    });

    it('points at the attempt that replaced a retired one', async () => {
      const first = await opened();
      gateway.lapseSession(first.sessionId);
      const second = await participant.openSession(first.input);
      if (second.outcome !== 'OPENED') throw new Error('expected a fresh attempt');
      gateway.authorize(second.providerSessionId);
      await participant.openSession(first.input);

      const statuses = await participant.statusOf([first.orderId]);

      expect(second.paymentId).not.toBe(first.paymentId);
      expect(statuses.get(first.orderId)).toMatchObject({
        header: 'AUTHORIZED',
        authorizedPaymentId: second.paymentId,
      });
    });

    it('answers a full batch, one key per id asked for', async () => {
      const { orderId } = await opened();
      const ids = [orderId, ...Array.from({ length: 199 }, () => testId())];

      const statuses = await participant.statusOf(ids);

      expect(statuses.size).toBe(200);
      expect(statuses.get(orderId)?.header).toBe('OPEN');
      expect([...statuses.values()].filter((status) => status.header === null)).toHaveLength(199);
    });

    it('answers an empty batch with an empty map', async () => {
      expect((await participant.statusOf([])).size).toBe(0);
    });
  });
});
