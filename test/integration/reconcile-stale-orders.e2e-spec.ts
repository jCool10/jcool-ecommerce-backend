import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';
import { PAYMENT_GATEWAY } from '@modules/payment/application/ports/payment-gateway.port';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '@modules/payment/application/ports/payment-repository.port';
import { PaymentStatus } from '@modules/payment/domain/payment-status';
import { ReconcileStaleOrdersUseCase } from '@modules/payment/application/use-cases';
import { FakeSignerGatewayAdapter } from '@modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_reconcile_secret_0123456789';
const STOCK = 5;
// Sweep everything on sight: the suite controls staleness by what it stages, not by waiting.
const SWEEP_ALL = { staleAfterSec: 0, ttlSec: 900, batchSize: 50 };

// The reconciliation sweep over real Postgres: proves a lost delivery still converges, an order
// nothing ever settles expires instead of holding stock forever, and one unreachable session cannot
// take the rest of the batch down with it.
describe('Reconcile stale orders (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let reconcile: ReconcileStaleOrdersUseCase;

  beforeAll(async () => {
    // The only boundary outside the system under test; every other collaborator is the real thing.
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET, RECONCILE_ENABLED: 'false' }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    reconcile = app.get(ReconcileStaleOrdersUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const server = () => app.getHttpServer();

  /** A real PENDING order (with a HELD reservation) plus an open payment session. */
  async function openPayment(): Promise<{ orderId: string; sessionId: string; variantId: string }> {
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
    return { orderId, sessionId: pay.body.providerSessionId as string, variantId };
  }

  async function placeOrderOnly(): Promise<{ orderId: string; variantId: string }> {
    const { accessToken: token } = await createTestUser(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 99_000 });
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
    return { orderId: order.body.id as string, variantId };
  }

  async function readOrder(id: string) {
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
    return row;
  }
  async function readPayment(orderId: string) {
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));
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

  it('settles an order whose paid webhook never arrived: order PAID, payment SUCCEEDED, hold committed', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 1, errors: 0 });
    const order = await readOrder(orderId);
    expect(order.status).toBe('PAID');
    expect(order.finalizeReason).toBe('reconcile:paid');
    expect((await readPayment(orderId)).status).toBe('SUCCEEDED');
    expect((await readReservation(orderId, variantId)).status).toBe('COMMITTED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  it('settles a gateway-side failure: order FAILED, payment FAILED, hold released', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'FAILED');

    await reconcile.execute(SWEEP_ALL);

    expect((await readOrder(orderId)).status).toBe('FAILED');
    expect((await readPayment(orderId)).status).toBe('FAILED');
    expect((await readReservation(orderId, variantId)).status).toBe('RELEASED');
    const stock = await readStock(variantId);
    expect(stock.quantityOnHand).toBe(STOCK);
    expect(stock.quantityReserved).toBe(0);
  });

  it('leaves an order the gateway still calls PENDING alone while it is inside its TTL', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PENDING');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 0, stillPending: 1 });
    expect((await readOrder(orderId)).status).toBe('PENDING');
    expect((await readReservation(orderId, variantId)).status).toBe('HELD');
  });

  it('expires an undecided order once past its TTL and gives the stock back', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PENDING');

    const summary = await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect(summary).toMatchObject({ scanned: 1, finalized: 1 });
    const order = await readOrder(orderId);
    expect(order.status).toBe('EXPIRED');
    expect(order.finalizeReason).toBe('reconcile:expired');
    expect((await readPayment(orderId)).status).toBe('EXPIRED');
    expect((await readReservation(orderId, variantId)).status).toBe('RELEASED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK);
    // The hosted page is closed before the stock goes back, or a late buyer would pay for an order
    // that no longer exists.
    expect(gateway.wasExpired(sessionId)).toBe(true);
  });

  it('keeps holding stock when the gateway will not close a still-payable session', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PENDING');
    gateway.failExpireSession(sessionId);

    const summary = await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect(summary).toMatchObject({ scanned: 1, finalized: 0, errors: 1 });
    expect((await readOrder(orderId)).status).toBe('PENDING');
    expect((await readPayment(orderId)).status).toBe('PENDING');
    expect((await readReservation(orderId, variantId)).status).toBe('HELD');
  });

  it('finishes a settled payment whose order finalize never landed — the gap the webhook path leaves', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    // The webhook's payment transaction committed; its separate finalize transaction did not.
    await db
      .update(schema.payments)
      .set({ status: 'SUCCEEDED', providerIntentId: 'pi_lost_finalize' })
      .where(eq(schema.payments.orderId, orderId));
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 1, errors: 0, unresolved: 0 });
    expect((await readOrder(orderId)).status).toBe('PAID');
    const payment = await readPayment(orderId);
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.providerIntentId).toBe('pi_lost_finalize'); // untouched: it was already terminal
    expect((await readReservation(orderId, variantId)).status).toBe('COMMITTED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  it('refuses to overwrite a payment status another writer already moved', async () => {
    const { orderId } = await openPayment();
    const payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    const payment = await payments.findByOrderId(orderId);

    const won = await payments.updateStatus(payment!.id!, PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    // Same guard, replayed against a row that has since moved — what the sweep does after a gateway
    // round-trip during which a webhook settled the payment.
    const lost = await payments.updateStatus(payment!.id!, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });

    expect(won?.status).toBe(PaymentStatus.SUCCEEDED);
    expect(lost).toBeNull();
    expect((await readPayment(orderId)).status).toBe('SUCCEEDED');
  });

  it('expires a past-TTL order that never opened a payment session, so its hold is not stranded', async () => {
    const { orderId, variantId } = await placeOrderOnly();

    await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect((await readOrder(orderId)).status).toBe('EXPIRED');
    expect((await readReservation(orderId, variantId)).status).toBe('RELEASED');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK);
  });

  it('skips an order younger than the stale threshold — a webhook may still be in flight', async () => {
    const { orderId, sessionId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute({ ...SWEEP_ALL, staleAfterSec: 3600 });

    expect(summary.scanned).toBe(0); // never queued, so the gateway was never asked
    expect((await readOrder(orderId)).status).toBe('PENDING');
  });

  it('is a no-op against an order the webhook already settled — stock committed exactly once', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    const recorded = await readPayment(orderId);
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        sessionId,
        { amountMinor: recorded.amountMinor, currency: recorded.currency },
        { eventId: 'evt_reconcile_race', paymentIntent: 'pi_e2e' },
      ),
    });
    await request(server()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody).expect(200);
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    // The order left PENDING when the webhook settled it, so the sweep's queue never sees it.
    expect(summary.scanned).toBe(0);
    expect((await readOrder(orderId)).status).toBe('PAID');
    expect((await readStock(variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  it('isolates an unreachable session: that order is retried later, the rest of the batch settles', async () => {
    const broken = await openPayment();
    const healthy = await openPayment();
    gateway.failPaymentStatus(broken.sessionId);
    gateway.setPaymentStatus(healthy.sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 2, finalized: 1, errors: 1 });
    expect((await readOrder(broken.orderId)).status).toBe('PENDING');
    expect((await readOrder(healthy.orderId)).status).toBe('PAID');
  });

  it('never processes more than the batch size in one sweep', async () => {
    const first = await openPayment();
    const second = await openPayment();
    const third = await openPayment();
    for (const { sessionId } of [first, second, third]) gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute({ ...SWEEP_ALL, batchSize: 2 });

    expect(summary).toMatchObject({ scanned: 2, finalized: 2 });
    const statuses = await Promise.all([first, second, third].map(async (o) => (await readOrder(o.orderId)).status));
    expect(statuses.filter((s) => s === 'PAID')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'PENDING')).toHaveLength(1); // the tail waits for the next sweep
  });
});
