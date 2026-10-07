import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import { ReconcileTccPaymentsUseCase } from '../../src/modules/payment/application/use-cases';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { manualSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_reconcile_tcc_payments_01';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';
const SWEEP = { staleAfterSec: 60, batchSize: 10 };

describe('Reconcile of fenced payments (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let reconcile: ReconcileTccPaymentsUseCase;
  let order: string;
  let sessionId: string;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, { RECONCILE_ENABLED: 'false' }));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
    reconcile = app.get(ReconcileTccPaymentsUseCase);
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

  /** Past the stale threshold, the one thing a test cannot wait for. */
  const age = (minutesAgo = 10) =>
    pool.query(`UPDATE payments SET updated_at = now() - make_interval(mins => $2) WHERE order_id = $1`, [
      order,
      minutesAgo,
    ]);

  const paymentEvents = () => db.select().from(schema.outbox).where(eq(schema.outbox.aggregateType, 'Payment'));

  async function authorizedThenCancelledWithHoldStuck(): Promise<string> {
    const intentId = gateway.authorize(sessionId);
    const event = manualSessionCompleted(sessionId, { amountMinor: AMOUNT_MINOR, currency: CURRENCY });
    await postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event })).expect(200);
    gateway.failVoid(intentId, 'timeout');
    await expect(participant.cancel(order)).rejects.toThrow();
    expect((await readPayment(app, order)).status).toBe('AUTHORIZED');
    return intentId;
  }

  it('leaves a payment touched inside the threshold to the webhook still in flight', async () => {
    gateway.authorize(sessionId);

    expect(await reconcile.execute(SWEEP)).toMatchObject({ scanned: 0 });
    expect((await readPayment(app, order)).status).toBe('PENDING');
  });

  it('records a hold whose webhook never arrived, and announces it', async () => {
    const intentId = gateway.authorize(sessionId);
    await age();

    expect(await reconcile.execute(SWEEP)).toMatchObject({ scanned: 1, authorized: 1 });

    expect(await readPayment(app, order)).toMatchObject({ status: 'AUTHORIZED', providerIntentId: intentId });
    expect((await readPaymentOrder(app, order)).status).toBe('AUTHORIZED');
    expect((await paymentEvents()).map((e) => e.eventType)).toEqual(['payment.authorized']);
  });

  it('expires a payment whose session Stripe lapsed', async () => {
    await gateway.expireSession(sessionId);
    await age();

    expect(await reconcile.execute(SWEEP)).toMatchObject({ expired: 1 });
    expect((await readPayment(app, order)).status).toBe('EXPIRED');
    expect(await paymentEvents()).toHaveLength(0);
  });

  // Released from the dashboard, or lapsed after its webhook was skipped: the header is still OPEN.
  it('records a hold released outside the saga, after which the order opens no new session', async () => {
    const intentId = gateway.authorize(sessionId);
    gateway.setIntentStatus(intentId, 'canceled');
    await age();

    expect(await reconcile.execute(SWEEP)).toMatchObject({ voided: 1 });
    expect((await readPayment(app, order)).status).toBe('VOIDED');
    expect((await readPaymentOrder(app, order)).status).toBe('OPEN');

    const reopened = await participant.openSession({
      orderId: order,
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    expect(reopened).toEqual({ outcome: 'CLOSED' });
  });

  it('voids a hold a cancel left behind', async () => {
    const intentId = await authorizedThenCancelledWithHoldStuck();
    await age();

    expect(await reconcile.execute(SWEEP)).toMatchObject({ voided: 1 });
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect((await readPayment(app, order)).status).toBe('VOIDED');
  });

  it('moves a probe that settles nothing to the back of the queue, leaving authorized_at as recorded', async () => {
    const intentId = await authorizedThenCancelledWithHoldStuck();
    await age();
    const before = await readPayment(app, order);
    gateway.failVoid(intentId, 'timeout');

    expect(await reconcile.execute(SWEEP)).toMatchObject({ errors: 1 });

    const after = await readPayment(app, order);
    expect(after).toMatchObject({ status: 'AUTHORIZED', authorizedAt: before.authorizedAt });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(await reconcile.execute(SWEEP)).toMatchObject({ scanned: 0 });
  });
});
