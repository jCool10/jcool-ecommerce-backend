import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type OpenSessionInput,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import { ReconcileTccPaymentsUseCase } from '../../src/modules/payment/application/use-cases';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_reconcile_tcc_secret_01';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };
const SWEEP = { staleAfterSec: 60, batchSize: 50 };

describe('Participant reconcile (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let reconcile: ReconcileTccPaymentsUseCase;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
    reconcile = app.get(ReconcileTccPaymentsUseCase);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const sessionInput = (): OpenSessionInput => ({
    orderId: testId(),
    ...CHARGE,
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
  });

  async function opened() {
    const input = sessionInput();
    const result = await participant.openSession(input);
    if (result.outcome !== 'OPENED') throw new Error(`expected OPENED, got ${result.outcome}`);
    return { orderId: input.orderId, sessionId: result.providerSessionId };
  }

  /** The one thing a sweep test cannot wait for. */
  const age = (orderId: string) =>
    pool.query(`update payments set updated_at = now() - interval '1 hour' where order_id = $1`, [orderId]);

  it('records a hold whose webhook never came', async () => {
    const { orderId, sessionId } = await opened();
    gateway.authorize(sessionId);
    await age(orderId);

    await expect(reconcile.execute(SWEEP)).resolves.toMatchObject({ scanned: 1, recorded: 1 });

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    const events = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, 'payment.authorized'));
    expect(events).toHaveLength(1);
  });

  it('retires an attempt whose session Stripe expired', async () => {
    const { orderId, sessionId } = await opened();
    gateway.lapseSession(sessionId);
    await age(orderId);

    await expect(reconcile.execute(SWEEP)).resolves.toMatchObject({ expired: 1 });

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'EXPIRED' });
  });

  it('leaves a payment younger than the threshold to its webhook', async () => {
    const { sessionId } = await opened();
    gateway.authorize(sessionId);

    // An hour, not a minute: the row is stamped by the container's clock, the cutoff by ours.
    await expect(reconcile.execute({ ...SWEEP, staleAfterSec: 3600 })).resolves.toMatchObject({ scanned: 0 });
  });

  it('voids a hold left under a cancelled order', async () => {
    const { orderId, sessionId } = await opened();
    const intentId = gateway.authorize(sessionId);
    gateway.failVoid(intentId, 'idempotency_in_flight');
    await expect(participant.cancel({ orderId })).rejects.toThrow();
    const late = checkoutSessionCompleted(sessionId, { ...CHARGE, paymentStatus: 'unpaid' }, { eventId: 'evt_late' });
    await postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event: late })).expect(200);
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    await age(orderId);

    await expect(reconcile.execute(SWEEP)).resolves.toMatchObject({ voided: 1 });

    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'VOIDED' });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED' });
  });
});
