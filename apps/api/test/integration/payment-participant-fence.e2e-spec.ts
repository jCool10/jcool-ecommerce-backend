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
import { manualSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_payment_participant_fence_01';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';
// Long enough that the other call starts inside the window, short enough to keep the suite quick.
const GATEWAY_DELAY_MS = 300;
const HEAD_START_MS = 100;

describe('Payment participant fence under races (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let order: string;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, { RECONCILE_ENABLED: 'false' }));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(() => {
    order = testId();
    gateway.delayCreateSession(0);
    gateway.delayExpireSession(0);
  });

  const open = () =>
    participant.openSession({
      orderId: order,
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

  const paymentsOfOrder = () => db.select().from(schema.payments).where(eq(schema.payments.orderId, order));

  async function expectNothingPayableUnderCancelledHeader(): Promise<void> {
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
    const payments = await paymentsOfOrder();
    expect(payments.length).toBeGreaterThan(0);
    for (const payment of payments) {
      expect(payment.status, payment.providerSessionId).not.toBe('PENDING');
      expect(gateway.wasExpired(payment.providerSessionId), payment.providerSessionId).toBe(true);
    }
  }

  // The open cannot see the cancel at its first check, and the cancel cannot see the session that
  // does not exist yet; the open's second check closes it.
  it('closes a session created while a cancel flipped the header', async () => {
    gateway.delayCreateSession(GATEWAY_DELAY_MS);

    const opening = open();
    await sleep(HEAD_START_MS);
    expect(await participant.cancel(order)).toEqual({ outcome: 'CANCELLED' });

    expect(await opening).toEqual({ outcome: 'CLOSED' });
    await expectNothingPayableUnderCancelledHeader();
  });

  it('leaves no session open when a slow cancel overlaps an open that replaces a dead session', async () => {
    const first = await open();
    if (first.outcome !== 'OPENED') throw new Error('expected an open session');
    // The probe reads the first session dead, so the open retires it and creates a second one.
    gateway.setPaymentStatus(first.providerSessionId, 'FAILED');
    gateway.delayCreateSession(GATEWAY_DELAY_MS);
    gateway.delayExpireSession(GATEWAY_DELAY_MS);

    const reopening = open();
    await sleep(HEAD_START_MS);
    const cancelling = participant.cancel(order);

    const [reopened, cancelled] = await Promise.all([reopening, cancelling]);
    expect(reopened).toEqual({ outcome: 'CLOSED' });
    expect(cancelled).toEqual({ outcome: 'CANCELLED' });
    expect(await paymentsOfOrder()).toHaveLength(2);
    await expectNothingPayableUnderCancelledHeader();
  });

  // The webhook commits between the cancel's two transactions; the second one still releases the hold.
  it('converges on a voided hold when the authorization lands in the middle of a cancel', async () => {
    const opened = await open();
    if (opened.outcome !== 'OPENED') throw new Error('expected an open session');
    const intentId = gateway.authorize(opened.providerSessionId);
    gateway.delayExpireSession(GATEWAY_DELAY_MS);
    const event = manualSessionCompleted(
      opened.providerSessionId,
      { amountMinor: AMOUNT_MINOR, currency: CURRENCY },
      { eventId: 'evt_auth_mid_cancel' },
    );

    const cancelling = participant.cancel(order);
    await sleep(HEAD_START_MS);
    const delivery = await postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event }));

    expect(await cancelling).toEqual({ outcome: 'CANCELLED' });
    expect(delivery.status).toBe(200);
    expect((await readPayment(app, order)).status).toBe('VOIDED');
    expect((await readPaymentOrder(app, order)).status).toBe('CANCELLED');
    expect(gateway.wasVoided(intentId)).toBe(true);
  });
});
