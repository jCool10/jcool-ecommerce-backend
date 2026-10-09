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
import { ReconcileTccPaymentsUseCase } from '../../src/modules/payment/application/use-cases/reconcile-tcc-payments.use-case';
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
  readOrder,
  readPayment,
  seedSellableSku,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { resetDatabase } from '../setup/reset-database';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_webhook_contract_0123456789';
const STOCK = 10;
const RECONCILE_ALL = { staleAfterSec: 0, batchSize: 50 };

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
  let reconcile: ReconcileTccPaymentsUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    reconcile = app.get(ReconcileTccPaymentsUseCase);
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

  // The webhook can land while the payment insert is still in flight. Nothing matches it yet, so it
  // is skipped and its redelivery is a duplicate; the reconcile is what finds the hold and records it.
  it('leaves a hold whose webhook overtook the payment insert to the reconcile, which records it', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;

    let overtaking: { rawBody: string; headers: Record<string, string> } | undefined;
    const create = payments.create.bind(payments);
    vi.spyOn(payments, 'create').mockImplementation(async (payment, tx) => {
      gateway.authorize(payment.providerSessionId);
      overtaking = signWebhook({
        secret: WEBHOOK_SECRET,
        event: checkoutSessionCompleted(
          payment.providerSessionId,
          { amountMinor: payment.amountMinor, currency: payment.currency, paymentStatus: 'unpaid' },
          { eventId: 'evt_overtakes_insert' },
        ),
      });
      await post(overtaking).expect(200);
      return create(payment, tx);
    });

    await openSession(app, token, orderId).expect(201);
    vi.restoreAllMocks();

    expect(await webhookRow('evt_overtakes_insert')).toMatchObject({ status: 'SKIPPED' });
    expect((await post(overtaking!).expect(200)).body).toEqual({ status: 'duplicate' });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);

    expect(await reconcile.execute(RECONCILE_ALL)).toMatchObject({ scanned: 1, authorized: 1 });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.AUTHORIZED);
  });

  // Manual capture completes the page with the money held, not taken: Stripe reports it unpaid.
  it('records a completion reported unpaid as an authorization when its PaymentIntent awaits capture', async () => {
    const order = await placeAndOpenSession(app, sku, 1);
    gateway.authorize(order.sessionId);

    const completed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        order.sessionId,
        { ...order.charge, paymentStatus: 'unpaid' },
        { eventId: 'evt_requires_capture' },
      ),
    });

    expect((await post(completed).expect(200)).body).toEqual({ status: 'processed' });
    expect(await webhookRow('evt_requires_capture')).toMatchObject({ status: 'PROCESSED' });
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.AUTHORIZED);
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PENDING);
  });

  it('skips a completion whose session holds no money yet', async () => {
    const order = await placeAndOpenSession(app, sku, 1);

    const completedUnpaid = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        order.sessionId,
        { ...order.charge, paymentStatus: 'unpaid' },
        { eventId: 'evt_unpaid' },
      ),
    });

    expect((await post(completedUnpaid).expect(200)).body).toEqual({ status: 'skipped' });
    expect(await webhookRow('evt_unpaid')).toMatchObject({ status: 'SKIPPED' });
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PENDING);
  });
});
