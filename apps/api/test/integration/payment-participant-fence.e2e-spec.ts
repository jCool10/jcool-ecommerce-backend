import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type OpenSessionInput,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_participant_fence_0123';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };
// Long enough for the other command to get through its own first transaction meanwhile.
const STRIPE_DELAY_MS = 400;
const HEAD_START_MS = 100;

describe('Payment participant under concurrency (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let participant: PaymentParticipant;
  let created: string[];

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    participant = app.get<PaymentParticipant>(PAYMENT_PARTICIPANT);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // Every session the fake hands out, whether or not a payment row ever points at it.
  beforeEach(() => {
    created = [];
    const createSession = gateway.createSession.bind(gateway);
    vi.spyOn(gateway, 'createSession').mockImplementation(async (input) => {
      const session = await createSession(input);
      created.push(session.providerSessionId);
      return session;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sessionInput = (): OpenSessionInput => ({
    orderId: testId(),
    ...CHARGE,
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
  });

  const paymentsOf = (orderId: string) => db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));

  async function expectNothingPayableUnderCancel(orderId: string): Promise<void> {
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CANCELLED' });
    expect((await paymentsOf(orderId)).filter((p) => p.status === 'PENDING')).toEqual([]);
    expect(created.filter((sessionId) => !gateway.wasExpired(sessionId))).toEqual([]);
  }

  it('never leaves a session open when a cancel lands while it is being created', async () => {
    const input = sessionInput();
    gateway.delayCreateSession(STRIPE_DELAY_MS);

    const open = participant.openSession(input);
    await sleep(HEAD_START_MS);
    const [opened, cancelled] = await Promise.all([open, participant.cancel({ orderId: input.orderId })]);

    expect(opened).toEqual({ outcome: 'CLOSED' });
    expect(cancelled).toBe('CANCELLED');
    expect(created).toHaveLength(1);
    await expectNothingPayableUnderCancel(input.orderId);
  });

  it('closes both the retired and the replacement session when a cancel races the replacement', async () => {
    const input = sessionInput();
    const first = await participant.openSession(input);
    if (first.outcome !== 'OPENED') throw new Error('expected OPENED');
    gateway.lapseSession(first.providerSessionId);
    gateway.delayCreateSession(STRIPE_DELAY_MS);
    gateway.delayExpireSession(STRIPE_DELAY_MS);

    const reopen = participant.openSession(input);
    await sleep(HEAD_START_MS);
    const [reopened] = await Promise.all([reopen, participant.cancel({ orderId: input.orderId })]);

    expect(reopened).toEqual({ outcome: 'CLOSED' });
    expect(created).toHaveLength(2);
    expect(await readPayment(app, input.orderId)).toMatchObject({ status: 'EXPIRED' });
    await expectNothingPayableUnderCancel(input.orderId);
  });

  // The webhook commits between the cancel's two transactions; whichever runs second must not undo
  // the other. Asserts where it ends up, not that no deadlock was ever retried.
  it('converges on a voided hold when the authorization webhook races the cancel', async () => {
    const input = sessionInput();
    const result = await participant.openSession(input);
    if (result.outcome !== 'OPENED') throw new Error('expected OPENED');
    const intentId = gateway.authorize(result.providerSessionId);
    gateway.delayExpireSession(STRIPE_DELAY_MS);
    const delivery = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        result.providerSessionId,
        { ...CHARGE, paymentStatus: 'unpaid' },
        { eventId: 'evt_race' },
      ),
    });

    const cancel = participant.cancel({ orderId: input.orderId });
    await sleep(HEAD_START_MS);
    const first = await postWebhook(app, delivery);
    await expect(cancel).resolves.toBe('CANCELLED');
    const final = first.status === 200 ? first : await postWebhook(app, delivery);

    expect(final.status).toBe(200);
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(await readPayment(app, input.orderId)).toMatchObject({ status: 'VOIDED' });
    expect(await readPaymentOrder(app, input.orderId)).toMatchObject({ status: 'CANCELLED' });
  });

  it('opens exactly one session when two opens race on a fresh order', async () => {
    const input = sessionInput();
    // Holds one create back so both opens are past their first transaction before either inserts;
    // without it the second open may simply find and reuse the first one's session.
    gateway.delayCreateSession(STRIPE_DELAY_MS);

    const results = await Promise.all([participant.openSession(input), participant.openSession(input)]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['CLOSED', 'OPENED']);
    expect((await paymentsOf(input.orderId)).map((p) => p.status)).toEqual(['PENDING']);
    const losers = created.filter((sessionId) => gateway.wasExpired(sessionId));
    expect(losers).toHaveLength(1);
  });
});
