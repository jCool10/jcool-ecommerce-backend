import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../../src/modules/payment/application/ports/payment-repository.port';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import {
  addToCart,
  postWebhook,
  readOrder,
  readPayment,
  readReservation,
  readStock,
} from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_reconcile_secret_0123456789';
const STOCK = 5;
// Sweep everything on sight: the suite controls staleness by what it stages, not by waiting.
const SWEEP_ALL = { staleAfterSec: 0, ttlSec: 900, batchSize: 50 };

describe('Reconcile stale orders (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let reconcile: ReconcileStaleOrdersUseCase;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, { RECONCILE_ENABLED: 'false' }));
    reconcile = app.get(ReconcileStaleOrdersUseCase);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  /** A real PENDING order (with a HELD reservation) plus an open payment session. */
  async function openPayment(): Promise<{ orderId: string; sessionId: string; variantId: string }> {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 150_000 });
    await seedStock(app, variantId, STOCK);
    await addToCart(app, token, variantId).expect(200);
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
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 99_000 });
    await seedStock(app, variantId, STOCK);
    await addToCart(app, token, variantId).expect(200);
    const order = await request(server())
      .post('/orders')
      .set(authHeader(token))
      .set(idempotencyKeyHeader())
      .expect(201);
    return { orderId: order.body.id as string, variantId };
  }

  it('settles a gateway-side failure: order FAILED, payment FAILED, hold released', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'FAILED');

    await reconcile.execute(SWEEP_ALL);

    expect((await readOrder(app, orderId)).status).toBe('FAILED');
    expect((await readPayment(app, orderId)).status).toBe('FAILED');
    expect((await readReservation(app, orderId, variantId)).status).toBe('RELEASED');
    const stock = await readStock(app, variantId);
    expect(stock.quantityOnHand).toBe(STOCK);
    expect(stock.quantityReserved).toBe(0);
  });

  it('leaves an order the gateway still calls PENDING alone while it is inside its TTL', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PENDING');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 0, stillPending: 1 });
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, variantId)).status).toBe('HELD');
  });

  it('expires an undecided order once past its TTL and gives the stock back', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PENDING');

    const summary = await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect(summary).toMatchObject({ scanned: 1, finalized: 1 });
    const order = await readOrder(app, orderId);
    expect(order.status).toBe('EXPIRED');
    expect(order.finalizeReason).toBe('reconcile:expired');
    expect((await readPayment(app, orderId)).status).toBe('EXPIRED');
    expect((await readReservation(app, orderId, variantId)).status).toBe('RELEASED');
    expect((await readStock(app, variantId)).quantityOnHand).toBe(STOCK);
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
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readPayment(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, variantId)).status).toBe('HELD');
  });

  it('finishes a settled payment whose order finalize never landed', async () => {
    const { orderId, sessionId, variantId } = await openPayment();
    // The webhook's payment transaction committed; its separate finalize transaction did not.
    await db
      .update(schema.payments)
      .set({ status: 'SUCCEEDED', providerIntentId: 'pi_lost_finalize' })
      .where(eq(schema.payments.orderId, orderId));
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 1, errors: 0, unresolved: 0 });
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    const payment = await readPayment(app, orderId);
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.providerIntentId).toBe('pi_lost_finalize'); // untouched: it was already terminal
    expect((await readReservation(app, orderId, variantId)).status).toBe('COMMITTED');
    expect((await readStock(app, variantId)).quantityOnHand).toBe(STOCK - 1);
  });

  // The gateway can still deliver `checkout.session.completed` after reconcile has already probed the
  // same PAID status and settled the order — a duplicate outcome under a fresh event id, not a
  // conflict, so it must not book a refund for money that in fact paid for this order.
  it('treats a late paid webhook for a session reconcile already settled as a no-op, booking no refund', async () => {
    const { orderId, sessionId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PAID');
    const metrics = app.get<MetricsPort>(METRICS);
    const refundOwed = vi.spyOn(metrics, 'recordRefundOwed');

    await reconcile.execute(SWEEP_ALL);
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    const settled = await readPayment(app, orderId);
    expect(settled.status).toBe('SUCCEEDED');

    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        sessionId,
        { amountMinor: settled.amountMinor, currency: settled.currency },
        { eventId: 'evt_late_after_reconcile', paymentIntent: 'pi_late' },
      ),
    });
    const res = await postWebhook(app, signed).expect(200);

    expect(res.body).toEqual({ status: 'skipped' });
    expect(refundOwed).not.toHaveBeenCalled();
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    const after = await readPayment(app, orderId);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.providerIntentId).toBeNull(); // the no-op touches nothing on the row, not even this
  });

  it('refuses to overwrite a payment status another writer already moved', async () => {
    const { orderId } = await openPayment();
    const payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    const payment = await payments.findByOrderId(orderId);

    const won = await payments.updateStatus(payment!.id!, PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    // The sweep's guard after a webhook settled the payment during its gateway round-trip.
    const lost = await payments.updateStatus(payment!.id!, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });

    expect(won?.status).toBe(PaymentStatus.SUCCEEDED);
    expect(lost).toBeNull();
    expect((await readPayment(app, orderId)).status).toBe('SUCCEEDED');
  });

  it('expires a past-TTL order that never opened a payment session', async () => {
    const { orderId, variantId } = await placeOrderOnly();

    await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect((await readOrder(app, orderId)).status).toBe('EXPIRED');
    expect((await readReservation(app, orderId, variantId)).status).toBe('RELEASED');
    expect((await readStock(app, variantId)).quantityOnHand).toBe(STOCK);
  });

  it('skips an order younger than the stale threshold', async () => {
    const { orderId, sessionId } = await openPayment();
    gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute({ ...SWEEP_ALL, staleAfterSec: 3600 });

    expect(summary.scanned).toBe(0); // never queued, so the gateway was never asked
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
  });

  it('leaves an unreachable session for later and settles the rest of the batch', async () => {
    const broken = await openPayment();
    const healthy = await openPayment();
    gateway.failPaymentStatus(broken.sessionId);
    gateway.setPaymentStatus(healthy.sessionId, 'PAID');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 2, finalized: 1, errors: 1 });
    expect((await readOrder(app, broken.orderId)).status).toBe('PENDING');
    expect((await readOrder(app, healthy.orderId)).status).toBe('PAID');
  });

  it('never processes more than the batch size in one sweep', async () => {
    const first = await openPayment();
    const second = await openPayment();
    const third = await openPayment();
    for (const { sessionId } of [first, second, third]) gateway.setPaymentStatus(sessionId, 'PAID');

    const summary = await reconcile.execute({ ...SWEEP_ALL, batchSize: 2 });

    expect(summary).toMatchObject({ scanned: 2, finalized: 2 });
    const statuses = await Promise.all(
      [first, second, third].map(async (o) => (await readOrder(app, o.orderId)).status),
    );
    expect(statuses.filter((s) => s === 'PAID')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'PENDING')).toHaveLength(1); // the tail waits for the next sweep
  });
});
