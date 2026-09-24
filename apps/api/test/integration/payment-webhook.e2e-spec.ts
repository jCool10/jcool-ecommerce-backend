import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readReservation,
  readStock,
  seedSellableSku,
  type OpenOrder,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  signWebhook,
  type SessionCharge,
  type SignedWebhook,
} from '../setup/sign-webhook.helper';

// The app verifies offline against this secret, so every signature below is a real HMAC.
const WEBHOOK_SECRET = 'whsec_e2e_test_secret_0123456789';
const STOCK = 5;

describe('Payment webhook (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const openOrder = async (): Promise<OpenOrder> =>
    placeAndOpenSession(app, await seedSellableSku(app, { onHand: STOCK }));

  const paid = (sessionId: string, charge: SessionCharge, eventId: string, paymentIntent = 'pi_e2e'): SignedWebhook =>
    signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge, { eventId, paymentIntent }),
    });
  const expired = (sessionId: string, eventId: string): SignedWebhook =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId }) });

  const webhookRows = () => db.select().from(schema.webhookEvents);

  async function expectSettledPaid({ orderId, variantId }: OpenOrder): Promise<void> {
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    expect((await readReservation(app, orderId, variantId)).status).toBe('COMMITTED');
    expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: STOCK - 1, quantityReserved: 0 });
  }

  async function expectUntouched({ orderId, variantId }: OpenOrder): Promise<void> {
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, variantId)).status).toBe('HELD');
    expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 1 });
  }

  it('settles a paid delivery: payment, order and stock move together', async () => {
    const order = await openOrder();

    const res = await postWebhook(app, paid(order.sessionId, order.charge, 'evt_ok_1', 'pi_e2e_123'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    const [event] = await webhookRows();
    expect(event).toMatchObject({ providerEventId: 'evt_ok_1', status: 'PROCESSED' });
    expect(event.processedAt).not.toBeNull();
    expect(await readPayment(app, order.orderId)).toMatchObject({
      status: 'SUCCEEDED',
      providerIntentId: 'pi_e2e_123',
    });
    expect((await readOrder(app, order.orderId)).paymentRef).toBe('pi_e2e_123');
    await expectSettledPaid(order);
  });

  it('rejects a body changed after signing with 401 and writes nothing', async () => {
    const order = await openOrder();
    const signed = paid(order.sessionId, order.charge, 'evt_tampered');

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

  it('settles a redelivered event id once', async () => {
    const order = await openOrder();
    const signed = paid(order.sessionId, order.charge, 'evt_dup_1');

    const first = await postWebhook(app, signed);
    const second = await postWebhook(app, signed);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body, second.body]).toEqual([{ status: 'processed' }, { status: 'duplicate' }]);
    expect(await webhookRows()).toHaveLength(1);
    await expectSettledPaid(order);
  });

  // The loser blocks on the winner's uncommitted insert behind UNIQUE(provider, event_id), then no-ops.
  it('settles two concurrent deliveries of one event once', async () => {
    const order = await openOrder();
    const signed = paid(order.sessionId, order.charge, 'evt_race_1');

    const results = await Promise.all([postWebhook(app, signed), postWebhook(app, signed)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'processed']);
    expect(await webhookRows()).toHaveLength(1);
    await expectSettledPaid(order);
  });

  it('keeps a paid order when a failure arrives after it', async () => {
    const order = await openOrder();
    await postWebhook(app, paid(order.sessionId, order.charge, 'evt_win', 'pi_win')).expect(200);

    const late = await postWebhook(app, expired(order.sessionId, 'evt_late_fail'));

    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'skipped' });
    expect(await readPayment(app, order.orderId)).toMatchObject({ status: 'SUCCEEDED', providerIntentId: 'pi_win' });
    const [lateRow] = await db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerEventId, 'evt_late_fail'));
    expect(lateRow.status).toBe('SKIPPED');
    await expectSettledPaid(order);
  });

  it('keeps a failed order when a payment arrives after it', async () => {
    const order = await openOrder();
    await postWebhook(app, expired(order.sessionId, 'evt_fail_first')).expect(200);

    const late = await postWebhook(app, paid(order.sessionId, order.charge, 'evt_paid_late'));

    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'skipped' });
    expect((await readOrder(app, order.orderId)).status).toBe('FAILED');
    expect((await readReservation(app, order.orderId, order.variantId)).status).toBe('RELEASED');
    expect(await readStock(app, order.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
  });

  it('fails the order and releases the hold on an expired session', async () => {
    const order = await openOrder();

    const res = await postWebhook(app, expired(order.sessionId, 'evt_fail_1'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect((await readOrder(app, order.orderId)).status).toBe('FAILED');
    expect((await readReservation(app, order.orderId, order.variantId)).status).toBe('RELEASED');
    expect((await readStock(app, order.variantId)).quantityReserved).toBe(0);
  });

  // Stripe's async payment methods complete the session while it is still unpaid.
  it('does not settle a completed session whose payment has not cleared', async () => {
    const order = await openOrder();

    const res = await postWebhook(
      app,
      paid(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' }, 'evt_unpaid'),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    await expectUntouched(order);
  });

  it('refuses a success reporting an amount that was never charged', async () => {
    const order = await openOrder();

    const res = await postWebhook(app, paid(order.sessionId, { ...order.charge, amountMinor: 1 }, 'evt_wrong_amount'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    await expectUntouched(order);
  });

  // Stripe reports real async clearance as checkout.session.async_payment_succeeded, which
  // payment-webhook-contract shows is not applied. This only proves a skipped event id blocks nothing.
  it('settles a paid completion that follows a skipped unpaid one', async () => {
    const order = await openOrder();
    await postWebhook(app, paid(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' }, 'evt_unpaid')).expect(
      200,
    );

    const res = await postWebhook(app, paid(order.sessionId, order.charge, 'evt_paid'));

    expect(res.body).toEqual({ status: 'processed' });
    await expectSettledPaid(order);
  });

  it('skips a delivery for a session with no local payment', async () => {
    const order = await openOrder();

    const res = await postWebhook(app, paid('cs_orphan_session', { amountMinor: 1, currency: 'VND' }, 'evt_orphan'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    expect(await webhookRows()).toMatchObject([{ providerEventId: 'evt_orphan', status: 'SKIPPED' }]);
    await expectUntouched(order);
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
