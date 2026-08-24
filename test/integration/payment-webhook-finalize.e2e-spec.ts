import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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

const WEBHOOK_SECRET = 'whsec_e2e_test_secret_0123456789';
const STOCK = 5;

// The full webhook → order-finalize path over real Postgres: proves the payment dedup guard and the
// order finalize guards compose into one exactly-once effect, and that a duplicate, out-of-order, or
// orphan delivery neither double-applies nor regresses.
describe('Payment webhook → order finalization (integration, real Postgres)', () => {
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

  // A real PENDING order (with a HELD reservation from checkout) + a PENDING payment session.
  async function openPayment(): Promise<{
    token: string;
    orderId: string;
    sessionId: string;
    variantId: string;
    charge: SessionCharge;
  }> {
    const { accessToken: token } = await createTestUser(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 150_000 });
    await seedStock(app, variantId, STOCK);
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
    const [recorded] = await db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));
    return {
      token,
      orderId,
      sessionId: pay.body.providerSessionId as string,
      variantId,
      // A settling event has to report the charge we actually recorded, exactly as the gateway would.
      charge: { amountMinor: recorded.amountMinor, currency: recorded.currency },
    };
  }

  function postWebhook(signed: SignedWebhook) {
    return request(server()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);
  }

  const paid = (sessionId: string, charge: SessionCharge, eventId: string, paymentIntent = 'pi_e2e') =>
    signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(sessionId, charge, { eventId, paymentIntent }),
    });
  const expired = (sessionId: string, eventId: string) =>
    signWebhook({ secret: WEBHOOK_SECRET, event: checkoutSessionExpired(sessionId, { eventId }) });

  async function readOrder(id: string) {
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
    return row;
  }
  async function readReservation(orderId: string, variantId: string) {
    const [row] = await db
      .select()
      .from(schema.reservations)
      .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.variantId, variantId)));
    return row;
  }
  async function readStock(variantId: string) {
    const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  it('paid webhook finalizes the order PAID and commits the hold in one move', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();

    const res = await postWebhook(paid(sessionId, charge, 'evt_paid_1'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readReservation(orderId, variantId)).status).toBe('COMMITTED');
    const stock = await readStock(variantId);
    expect(stock.quantityOnHand).toBe(STOCK - 1); // committed for real
    expect(stock.quantityReserved).toBe(0);
    expect((await readOrder(orderId)).paymentRef).toBe('pi_e2e');
  });

  it('a completed session whose payment has not cleared hands over nothing — no PAID order, no stock', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();

    // Stripe's async payment methods complete the session while it is still `unpaid`, and only clear
    // later. Settling on the event type alone would give this buyer the goods before the money.
    const res = await postWebhook(paid(sessionId, { ...charge, paymentStatus: 'unpaid' }, 'evt_unpaid'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    expect((await readOrder(orderId)).status).toBe('PENDING');
    // The hold survives: still the buyer's stock, still not theirs to keep.
    expect((await readReservation(orderId, variantId)).status).toBe('HELD');
    const stock = await readStock(variantId);
    expect(stock.quantityOnHand).toBe(STOCK);
    expect(stock.quantityReserved).toBe(1);
  });

  it('a success reporting an amount we never charged is refused — order and stock untouched', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();

    const res = await postWebhook(paid(sessionId, { ...charge, amountMinor: 1 }, 'evt_wrong_amount'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    expect((await readOrder(orderId)).status).toBe('PENDING');
    expect((await readReservation(orderId, variantId)).status).toBe('HELD');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK);
  });

  it('settles once the async payment clears — the earlier unpaid notice did not burn the event stream', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();
    await postWebhook(paid(sessionId, { ...charge, paymentStatus: 'unpaid' }, 'evt_async_pending')).expect(200);

    const res = await postWebhook(paid(sessionId, charge, 'evt_async_cleared'));

    expect(res.body).toEqual({ status: 'processed' });
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readReservation(orderId, variantId)).status).toBe('COMMITTED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  it('duplicate delivery (same event id) never finalizes twice — stock committed once', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();
    const signed = paid(sessionId, charge, 'evt_dup_1');

    const first = await postWebhook(signed);
    const second = await postWebhook(signed);

    expect(first.body).toEqual({ status: 'processed' });
    expect(second.body).toEqual({ status: 'duplicate' });
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1); // not STOCK - 2
  });

  it('failed AFTER paid does not regress: order stays PAID, stock unchanged', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();
    await postWebhook(paid(sessionId, charge, 'evt_win')).then((r) => expect(r.status).toBe(200));

    const late = await postWebhook(expired(sessionId, 'evt_late_fail'));

    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'skipped' }); // payment-layer conflict guard, never reaches finalize
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readReservation(orderId, variantId)).status).toBe('COMMITTED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  it('paid AFTER failed does not regress: order stays FAILED, stock stays released', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();
    await postWebhook(expired(sessionId, 'evt_fail_first')).then((r) => expect(r.status).toBe(200));

    const late = await postWebhook(paid(sessionId, charge, 'evt_paid_late'));

    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'skipped' });
    expect((await readOrder(orderId)).status).toBe('FAILED');
    expect((await readReservation(orderId, variantId)).status).toBe('RELEASED');
    const stock = await readStock(variantId);
    expect(stock.quantityOnHand).toBe(STOCK); // released holds never left the shelf
    expect(stock.quantityReserved).toBe(0);
  });

  it('failed webhook finalizes the order FAILED and releases the hold', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();

    const res = await postWebhook(expired(sessionId, 'evt_fail_1'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect((await readOrder(orderId)).status).toBe('FAILED');
    expect((await readReservation(orderId, variantId)).status).toBe('RELEASED');
    expect((await readStock(variantId)).quantityReserved).toBe(0);
  });

  it('webhook for an unknown session (arrived before the order) acks 2xx and finalizes nothing', async () => {
    const { orderId } = await openPayment();

    // No local payment for this handle, so the charge is never compared — the lookup misses first.
    const res = await postWebhook(paid('cs_orphan_session', { amountMinor: 1, currency: 'VND' }, 'evt_orphan'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' }); // no payment matches → reconciliation seam, no order created
    expect((await readOrder(orderId)).status).toBe('PENDING'); // the real order is untouched
  });

  it('out-of-scope event type (refund) acks 2xx and leaves the order PENDING', async () => {
    const { orderId, sessionId, charge } = await openPayment();

    const res = await postWebhook(
      signWebhook({
        secret: WEBHOOK_SECRET,
        event: { id: 'evt_refund', type: 'charge.refunded', data: { object: { id: sessionId } } },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    expect((await readOrder(orderId)).status).toBe('PENDING');
  });

  it('is exactly-once under CONCURRENT paid deliveries: one finalize, stock committed once', async () => {
    const { orderId, sessionId, variantId, charge } = await openPayment();
    const signed = paid(sessionId, charge, 'evt_race_1');

    const results = await Promise.all([postWebhook(signed), postWebhook(signed)]);

    for (const r of results) expect(r.status).toBe(200);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'processed']);
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1); // committed once, not twice
  });
});
