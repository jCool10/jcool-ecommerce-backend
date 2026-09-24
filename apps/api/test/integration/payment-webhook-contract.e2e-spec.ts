import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../../src/modules/payment/application/ports/payment-repository.port';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases/reconcile-stale-orders.use-case';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  buyerWithCart,
  checkout,
  openSession,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  seedSellableSku,
  signOutcome,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { waitUntilBlockedOnLock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { checkoutSessionCompleted, signWebhook, type SessionCharge } from '../setup/sign-webhook.helper';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_webhook_contract_0123456789';
const STOCK = 10;
const RECONCILE_ALL = { staleAfterSec: 0, ttlSec: 3_600, batchSize: 50 };

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

// A genuine signature over arbitrary bytes: shapes only an authentic sender can produce.
function signRaw(rawBody: string): { rawBody: string; headers: Record<string, string> } {
  const ts = Math.floor(Date.now() / 1000);
  return {
    rawBody,
    headers: {
      [STRIPE_SIGNATURE_HEADER]: signStripeStyle(WEBHOOK_SECRET, ts, rawBody),
      'content-type': 'application/json',
    },
  };
}

describe('Payment webhook contract at the edges (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let payments: PaymentRepositoryPort;
  let reconcile: ReconcileStaleOrdersUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    reconcile = app.get(ReconcileStaleOrdersUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const webhookRows = () => db.select().from(schema.webhookEvents);
  const webhookRow = async (providerEventId: string) =>
    (await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.providerEventId, providerEventId)))[0];

  const post = (signed: { rawBody: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);

  // Known defect. Intended: an authentically signed delivery gets a deliberate answer and leaves a
  // record. Actual: verifyAndParseStripeEvent runs JSON.parse and the id/type check unguarded, before
  // ProcessWebhookEventUseCase opens its transaction, so the answer is an unmapped 500 that Stripe
  // retries, and no webhook_events row is written.
  it('500s an authentic delivery whose body shape it cannot read, and records nothing', async () => {
    await post(signRaw(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }))).expect(500);
    await post(signRaw(JSON.stringify({ id: 42, type: 'checkout.session.completed' }))).expect(500);
    await post(signRaw(JSON.stringify([{ type: 'checkout.session.completed' }]))).expect(500);

    expect(await webhookRows()).toHaveLength(0);
  });

  // Known defect. Intended: a signed delivery is recorded before it is judged. Actual: Express's
  // strict JSON parser refuses non-JSON and bare scalars before the signature is checked, and
  // nothing is written.
  it('refuses an unparseable body with 400 before verifying, recording nothing', async () => {
    await post(signRaw('<html>502 Bad Gateway</html>')).expect(400);
    await post(signRaw(JSON.stringify('checkout.session.completed'))).expect(400);

    expect(await webhookRows()).toHaveLength(0);
  });

  // Known defect. Intended: a settling event is applied to the payment it names whenever it
  // arrives. Actual: ProcessWebhookEventUseCase marks an event that overtakes the payment insert
  // SKIPPED, the unique index turns the redelivery into a duplicate, and only reconcile recovers.
  it('burns an event that overtakes the payment insert until reconcile recovers', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const placed = await checkout(app, token).expect(201);
    const orderId = placed.body.id as string;

    // The gateway fires its webhook while our insert is still in flight.
    let overtaking: { rawBody: string; headers: Record<string, string> } | undefined;
    const create = payments.create.bind(payments);
    vi.spyOn(payments, 'create').mockImplementation(async (payment, tx) => {
      overtaking = signWebhook({
        secret: WEBHOOK_SECRET,
        event: checkoutSessionCompleted(
          payment.providerSessionId,
          { amountMinor: payment.amountMinor, currency: payment.currency },
          { eventId: 'evt_overtakes_insert', paymentIntent: 'pi_overtake' },
        ),
      });
      await post(overtaking).expect(200);
      return create(payment, tx);
    });

    const pay = await openSession(app, token, orderId).expect(201);
    const sessionId = pay.body.providerSessionId as string;
    vi.restoreAllMocks();

    expect(await webhookRow('evt_overtakes_insert')).toMatchObject({ status: 'SKIPPED' });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);

    const retry = await post(overtaking!).expect(200);
    expect(retry.body).toEqual({ status: 'duplicate' });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);
    expect(await webhookRows()).toHaveLength(1);

    gateway.setPaymentStatus(sessionId, 'PAID', 'pi_overtake');
    expect(await reconcile.execute(RECONCILE_ALL)).toMatchObject({ scanned: 1, finalized: 1 });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PAID);
  });

  // Known defect. Intended: checkout.session.async_payment_succeeded settles the payment it names,
  // since the completion before it was left unpaid. Actual: mapEventToOutcome knows two event types
  // and ignores the rest, so the payment stays PENDING until reconcile polls it.
  it('ignores an async payment success, leaving the payment PENDING on cleared money', async () => {
    const order = await placeAndOpenSession(app, sku, 1);

    const completedUnpaid = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        order.sessionId,
        { ...order.charge, paymentStatus: 'unpaid' },
        { eventId: 'evt_async_completed' },
      ),
    });
    expect((await post(completedUnpaid).expect(200)).body).toEqual({ status: 'skipped' });
    expect(await webhookRow('evt_async_completed')).toMatchObject({ status: 'SKIPPED' });

    const asyncSucceeded = signWebhook({
      secret: WEBHOOK_SECRET,
      event: {
        id: 'evt_async_succeeded',
        type: 'checkout.session.async_payment_succeeded',
        data: { object: { id: order.sessionId, payment_status: 'paid', ...toSessionCharge(order.charge) } },
      },
    });

    expect((await post(asyncSucceeded).expect(200)).body).toEqual({ status: 'ignored' });

    expect(await webhookRow('evt_async_succeeded')).toMatchObject({ status: 'RECEIVED' });
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PENDING);
  });

  // Two different events pass the webhook_events dedup; the payment row lock serializes them and
  // canTransition refuses the loser.
  it('lets one of two racing settlements win and refuses the other', async () => {
    const order = await placeAndOpenSession(app, sku, 1);

    // The winner waits inside its transaction until the loser parks on the row lock.
    let held = false;
    const readLocked = payments.findByProviderSessionId.bind(payments);
    vi.spyOn(payments, 'findByProviderSessionId').mockImplementation(async (sessionId, tx) => {
      const row = await readLocked(sessionId, tx);
      if (tx && !held) {
        held = true;
        await waitUntilBlockedOnLock(pool, { subject: 'the second settlement' });
      }
      return row;
    });

    const [completed, expired] = await Promise.all([
      postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_race_completed')),
      postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'FAILED', 'evt_race_expired')),
    ]);
    vi.restoreAllMocks();

    expect([completed.status, expired.status]).toEqual([200, 200]);
    expect([completed.body.status, expired.body.status].sort()).toEqual(['processed', 'skipped']);

    const rows = await webhookRows();
    expect(rows.map((row) => row.status).sort()).toEqual(['PROCESSED', 'SKIPPED']);

    const winner = rows.find((row) => row.status === 'PROCESSED');
    const expectedStatus =
      winner?.providerEventId === 'evt_race_completed' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED;
    expect((await readPayment(app, order.orderId)).status).toBe(expectedStatus);
  });
});

// The charge fields as the gateway nests them, for an event no helper builds.
function toSessionCharge(charge: SessionCharge): Record<string, unknown> {
  return { amount_total: charge.amountMinor, currency: charge.currency?.toLowerCase() };
}
