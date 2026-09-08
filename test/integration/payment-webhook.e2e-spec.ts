import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  signWebhook,
  type SessionCharge,
  type SignedWebhook,
} from '../setup/sign-webhook.helper';

// The secret the app boots with AND the tests sign fixtures with — the coded Stripe adapter verifies
// offline against this, so the signatures are real HMACs over the real bodies (no network, no mock).
const WEBHOOK_SECRET = 'whsec_e2e_test_secret_0123456789';

// The payment webhook over real Postgres: a valid signature settles exactly once, a forged or expired
// one writes nothing, a duplicate event id no-ops, and an out-of-order event cannot clobber a settled
// payment. Finalize behaviour itself is covered in payment-webhook-finalize.e2e-spec.
describe('Payment webhook (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET });
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const server = () => app.getHttpServer();

  async function openPayment(): Promise<{
    token: string;
    orderId: string;
    paymentId: string;
    sessionId: string;
    charge: SessionCharge;
  }> {
    const { accessToken: token } = await createTestUser(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 150_000 });
    await seedStock(app, variantId, 5);
    await request(server())
      .post('/cart/items')
      .set(authHeader(token))
      .send({ skuId: variantId, quantity: 1 })
      .expect(200);
    const order = await request(server())
      .post('/orders')
      .set(authHeader(token))
      .set(idempotencyKeyHeader())
      .expect(201);
    const orderId = order.body.id as string;
    const pay = await request(server()).post(`/orders/${orderId}/pay`).set(authHeader(token)).expect(201);
    const paymentId = pay.body.paymentId as string;
    const recorded = await paymentRow(paymentId);
    return {
      token,
      orderId,
      paymentId,
      sessionId: pay.body.providerSessionId as string,
      // A settling event has to report the charge we actually recorded, exactly as the gateway would.
      charge: { amountMinor: recorded.amountMinor, currency: recorded.currency },
    };
  }

  function postWebhook(signed: SignedWebhook) {
    return request(server()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);
  }

  async function webhookRows() {
    return db.select().from(schema.webhookEvents);
  }

  async function paymentRow(paymentId: string) {
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    return row;
  }

  it('accepts a valid first-delivery success: 200, one PROCESSED event, payment SUCCEEDED, intent captured', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge, { eventId: 'evt_ok_1', paymentIntent: 'pi_e2e_123' }),
    });

    const res = await postWebhook(signed);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });

    const events = await webhookRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerEventId: 'evt_ok_1', status: 'PROCESSED' });
    expect(events[0].processedAt).not.toBeNull();

    expect(await paymentRow(paymentId)).toMatchObject({ status: 'SUCCEEDED', providerIntentId: 'pi_e2e_123' });
  });

  it('rejects an invalid signature with 401, writes no event, leaves the payment PENDING', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    const signed = signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionCompleted(sessionId, charge) });
    // Mutate one byte AFTER signing — the HMAC no longer covers the bytes we send (raw-body sensitivity).
    const tampered: SignedWebhook = { ...signed, rawBody: `${signed.rawBody} ` };

    const res = await postWebhook(tampered);

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
  });

  it('rejects a signature outside the tolerance window with 401 (replay defense), writes nothing', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge),
      timestampSec: oneHourAgo,
    });

    const res = await postWebhook(signed);

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
  });

  it('is exactly-once for a duplicate event id: both 2xx, one event row, payment SUCCEEDED once', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge, { eventId: 'evt_dup_1', paymentIntent: 'pi_dup' }),
    });

    const first = await postWebhook(signed);
    const second = await postWebhook(signed); // byte-identical redelivery

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'processed' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'duplicate' });

    expect(await webhookRows()).toHaveLength(1);
    expect((await paymentRow(paymentId)).status).toBe('SUCCEEDED');
  });

  it('is exactly-once under CONCURRENT redelivery: one winner + one no-op, one row, applied once', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge, { eventId: 'evt_race_1', paymentIntent: 'pi_race' }),
    });

    // Fire both byte-identical deliveries at once: the reason insert+apply live in ONE tx behind the
    // UNIQUE(provider, event_id) index. The loser blocks on the winner's uncommitted insert, then
    // sees the committed row and no-ops — exactly one apply, no double-charge.
    const results = await Promise.all([postWebhook(signed), postWebhook(signed)]);

    for (const r of results) expect(r.status).toBe(200);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'processed']);
    expect(await webhookRows()).toHaveLength(1);
    expect((await paymentRow(paymentId)).status).toBe('SUCCEEDED');
  });

  it('skips an out-of-order failure after success without downgrading the payment (200 skipped, event SKIPPED)', async () => {
    const { paymentId, sessionId, charge } = await openPayment();
    await postWebhook(
      signWebhook({
        secret: WEBHOOK_SECRET,
        event: checkoutSessionCompleted(sessionId, charge, { eventId: 'evt_win', paymentIntent: 'pi_win' }),
      }),
    ).then((r) => expect(r.status).toBe(200));

    const late = await postWebhook(
      signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId: 'evt_late_fail' }) }),
    );

    expect(late.status).toBe(200);
    // The gateway only needs a 2xx; the internal skip reason is not leaked over HTTP. Below proves it
    // was the CONFLICT guard, not a lookup miss: the payment for this same session is still SUCCEEDED
    // with its intent intact (so the late event DID resolve the payment) and its own row is SKIPPED.
    expect(late.body).toEqual({ status: 'skipped' });
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'SUCCEEDED', providerIntentId: 'pi_win' });

    const [lateRow] = await db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerEventId, 'evt_late_fail'));
    expect(lateRow.status).toBe('SKIPPED');
  });

  it('logs but skips a success for a session with no local payment (reconciliation seam)', async () => {
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      // No local payment for this handle, so the charge is never compared — the lookup misses first.
      event: checkoutSessionCompleted(
        'cs_test_orphan_session',
        { amountMinor: 150_000, currency: 'VND' },
        { eventId: 'evt_orphan' },
      ),
    });

    const res = await postWebhook(signed);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' }); // reason not leaked over HTTP; asserted at the DB below
    const [row] = await webhookRows();
    expect(row).toMatchObject({ providerEventId: 'evt_orphan', status: 'SKIPPED' });
  });

  it('finalizes the Order to PAID after a success webhook (payment settle drives order finalize)', async () => {
    const { token, orderId, sessionId, charge } = await openPayment();
    await postWebhook(
      signWebhook({
        secret: WEBHOOK_SECRET,
        event: checkoutSessionCompleted(sessionId, charge, { eventId: 'evt_final' }),
      }),
    ).then((r) => expect(r.status).toBe(200));

    const order = await request(server()).get(`/orders/${orderId}`).set(authHeader(token)).expect(200);
    expect(order.body.status).toBe('PAID');
  });
});
