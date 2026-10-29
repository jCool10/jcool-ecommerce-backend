import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  signWebhook,
  type SessionCharge,
  type SignedWebhook,
} from '../setup/sign-webhook.helper';

// The app verifies offline against this secret, so every signature below is a real HMAC.
const WEBHOOK_SECRET = 'whsec_e2e_test_secret_0123456789';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };
const ORPHAN_SESSION = 'cs_orphan_session';

interface OpenOrder {
  orderId: string;
  sessionId: string;
  charge: SessionCharge;
}

// What a participant payment does with an event is payment-authorization-webhook's subject; this one
// covers the edge every event crosses first, and the sessions no checkout owns.
describe('Payment webhook (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let refundOwed: MockInstance<MetricsPort['recordRefundOwed']>;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  beforeEach(() => {
    vi.restoreAllMocks();
    refundOwed = vi.spyOn(app.get<MetricsPort>(METRICS), 'recordRefundOwed');
  });

  // Authorized at the fake gateway, so an authentic completion would be recorded.
  const openOrder = async (): Promise<OpenOrder> => {
    const orderId = testId();
    const session = await app.get<PaymentParticipant>(PAYMENT_PARTICIPANT).openSession({
      orderId,
      ...CHARGE,
      expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
    });
    if (session.outcome !== 'OPENED') throw new Error(`expected OPENED, got ${session.outcome}`);
    gateway.authorize(session.providerSessionId);
    return { orderId, sessionId: session.providerSessionId, charge: CHARGE };
  };

  const completed = (sessionId: string, charge: SessionCharge, eventId: string): SignedWebhook =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionCompleted(sessionId, charge, { eventId }) });
  const expired = (sessionId: string, eventId: string): SignedWebhook =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId }) });

  const webhookRows = () => db.select().from(schema.webhookEvents);

  async function expectUntouched({ orderId }: OpenOrder): Promise<void> {
    expect((await readPaymentOrder(app, orderId)).status).toBe('OPEN');
    expect((await readPayment(app, orderId)).status).toBe('PENDING');
    expect(await db.select().from(schema.outbox)).toEqual([]);
  }

  it('rejects a body changed after signing with 401 and writes nothing', async () => {
    const order = await openOrder();
    const signed = completed(order.sessionId, order.charge, 'evt_tampered');

    const res = await postWebhook(app, { ...signed, rawBody: `${signed.rawBody} ` });

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    await expectUntouched(order);
  });

  it('rejects a signature outside the tolerance window with 401', async () => {
    const order = await openOrder();
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(order.sessionId, order.charge),
      timestampSec: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await postWebhook(app, signed);

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    await expectUntouched(order);
  });

  // The loser blocks on the winner's uncommitted insert behind UNIQUE(provider, event_id), then no-ops.
  it('records two concurrent deliveries of one event once', async () => {
    const order = await openOrder();
    const signed = completed(order.sessionId, order.charge, 'evt_race_1');

    const results = await Promise.all([postWebhook(app, signed), postWebhook(app, signed)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'processed']);
    expect(await webhookRows()).toHaveLength(1);
    expect((await readPayment(app, order.orderId)).status).toBe('AUTHORIZED');
  });

  // Nothing will ever capture or void a session no saga owns, so the cleared money is owed back.
  it('skips a delivery for a session with no local payment, booking a refund', async () => {
    const order = await openOrder();

    const res = await postWebhook(app, completed(ORPHAN_SESSION, { amountMinor: 1, currency: 'VND' }, 'evt_orphan'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    expect(await webhookRows()).toMatchObject([{ providerEventId: 'evt_orphan', status: 'SKIPPED' }]);
    expect(refundOwed.mock.calls).toEqual([['webhook_direct']]);
    await expectUntouched(order);
  });

  it('books no refund for such a session when no money cleared', async () => {
    const unpaid = completed(ORPHAN_SESSION, { amountMinor: 1, currency: 'VND', paymentStatus: 'unpaid' }, 'evt_u');

    await postWebhook(app, unpaid).expect(200, { status: 'skipped' });
    await postWebhook(app, expired(ORPHAN_SESSION, 'evt_e')).expect(200, { status: 'skipped' });

    expect((await webhookRows()).map((row) => row.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(refundOwed).not.toHaveBeenCalled();
  });

  it('ignores an event type it does not act on', async () => {
    const order = await openOrder();
    const refund = signWebhook({
      secret: WEBHOOK_SECRET,
      event: { id: 'evt_refund', type: 'charge.refunded', data: { object: { id: order.sessionId } } },
    });

    const res = await postWebhook(app, refund);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    await expectUntouched(order);
  });
});
