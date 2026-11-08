import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isProviderUnavailable, paymentRoutes } from '@jcool/internal-contracts';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authorizeSession, readPayment, readPaymentOrder, readRefund } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  internalPost,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { scrapeMetrics } from '../setup/metrics.helper';

const WEBHOOK_SECRET = 'whsec_e2e_payments_refund_000001';
const AMOUNT = 150_000;

// What the order-service sees of a refund: the HTTP status and the outcome, over real Postgres.
describe('Refund over the internal API (integration, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function authorized() {
    const orderId = testId();
    const { body } = await internalPost(app, paymentRoutes.session(orderId))
      .send({ amountMinor: AMOUNT, currency: 'VND', expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      .expect(200);
    const intentId = await authorizeSession(app, body.providerSessionId, orderId);
    return { orderId, intentId };
  }

  async function captured() {
    const order = await authorized();
    await internalPost(app, paymentRoutes.capture(order.orderId)).expect(200, { outcome: 'CAPTURED' });
    return order;
  }

  const refund = (orderId: string, requestedBy: unknown = testId()) =>
    internalPost(app, paymentRoutes.refund(orderId)).send({ requestedBy });

  const counted = async () => {
    const scrape = await scrapeMetrics(app);
    return {
      owed: scrape.value('payment_refund_owed_total', { source: 'refund_failed' }) ?? 0,
      failedBranch:
        scrape.value('tcc_branch_total', { participant: 'payment', op: 'refund', outcome: 'refund_failed' }) ?? 0,
    };
  };

  it('refunds a captured order in full once, recording the admin on the row and in Stripe', async () => {
    const { orderId, intentId } = await captured();
    const admin = testId();

    await refund(orderId, admin).expect(200, { outcome: 'REFUNDED' });

    const stripeRefunds = gateway.refundsOf(intentId);
    expect(stripeRefunds).toHaveLength(1);
    expect(stripeRefunds[0]).toMatchObject({
      amountMinor: AMOUNT,
      status: 'succeeded',
      metadata: { order_id: orderId, requested_by: admin },
    });
    const { id: paymentId } = await readPayment(app, orderId);
    expect(await readRefund(app, orderId)).toMatchObject({
      paymentId,
      providerRefundId: stripeRefunds[0].id,
      requestedBy: admin,
      amountMinor: AMOUNT,
      currency: 'VND',
      status: 'SUCCEEDED',
      failureReason: null,
    });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDED' });
  });

  it('answers a repeat as idempotent and keeps the first admin', async () => {
    const { orderId, intentId } = await captured();
    const first = testId();

    await refund(orderId, first).expect(200, { outcome: 'REFUNDED' });
    await refund(orderId).expect(200, { outcome: 'IDEMPOTENT' });

    expect(gateway.refundsOf(intentId)).toHaveLength(1);
    expect(await readRefund(app, orderId)).toMatchObject({ requestedBy: first });
  });

  it('sends one refund to Stripe however many admins ask at once', async () => {
    const { orderId, intentId } = await captured();

    const answers = await Promise.all(Array.from({ length: 20 }, () => refund(orderId)));

    expect(answers.map((res) => res.status).filter((status) => status !== 200)).toEqual([]);
    expect(new Set(answers.map((res) => res.body.outcome))).toSatisfy((outcomes: Set<string>) =>
      [...outcomes].every((outcome) => outcome === 'REFUNDED' || outcome === 'IDEMPOTENT'),
    );
    expect(gateway.refundsOf(intentId)).toHaveLength(1);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDED' });
  });

  it('adopts a refund Stripe applied before answering 500, under the same key', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_applied_then_500');

    await refund(orderId).expect(200, { outcome: 'REFUNDED' });

    expect(gateway.refundsOf(intentId)).toHaveLength(1);
    expect(await readPayment(app, orderId)).toMatchObject({ stripeKeyGen: 0 });
  });

  it('retries a refund Stripe refused with a 500 under a fresh key, after a 503', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'server_error');

    const res = await refund(orderId).expect(503);

    expect(res.headers['retry-after']).toBe('1');
    expect(isProviderUnavailable(res.status, res.body)).toBe(true);
    expect(gateway.refundsOf(intentId)).toHaveLength(0);
    expect(await readPayment(app, orderId)).toMatchObject({ stripeKeyGen: 1 });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDING' });

    await refund(orderId).expect(200, { outcome: 'REFUNDED' });
    expect(gateway.refundsOf(intentId)).toHaveLength(1);
  });

  it('answers a refund Stripe holds as pending with 202, and reads it back on the next ask', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_pending');

    await refund(orderId).expect(202, { outcome: 'PENDING' });
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDING' });
    const [pending] = gateway.refundsOf(intentId);
    expect(await readRefund(app, orderId)).toMatchObject({ providerRefundId: pending.id, status: 'PENDING' });

    await refund(orderId).expect(202, { outcome: 'PENDING' });
    gateway.settleRefund(pending.id, 'succeeded');
    await refund(orderId).expect(200, { outcome: 'REFUNDED' });

    expect(gateway.refundsOf(intentId)).toHaveLength(1);
    expect(await readRefund(app, orderId)).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('answers a refund Stripe failed with 409 and its reason, owed once, and never tries again', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_fails');
    const before = await counted();

    await refund(orderId).expect(409, { outcome: 'REFUND_FAILED', reason: 'expired_or_canceled_card' });
    await refund(orderId).expect(409, { outcome: 'REFUND_FAILED', reason: 'expired_or_canceled_card' });

    expect(await counted()).toEqual({ owed: before.owed + 1, failedBranch: before.failedBranch + 2 });
    expect(gateway.refundsOf(intentId)).toHaveLength(1);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUND_FAILED' });
    expect(await readRefund(app, orderId)).toMatchObject({
      status: 'FAILED',
      failureReason: 'expired_or_canceled_card',
    });
  });

  it('answers 409 for an order that holds no captured charge, and writes nothing', async () => {
    const { orderId: held } = await authorized();
    const unknown = testId();

    await refund(held).expect(409, { outcome: 'NOT_REFUNDABLE' });
    await refund(unknown).expect(409, { outcome: 'NOT_REFUNDABLE' });

    expect(await readPaymentOrder(app, held)).toMatchObject({ status: 'AUTHORIZED' });
    expect(await readRefund(app, held)).toBeUndefined();
    expect(await readPaymentOrder(app, unknown)).toBeUndefined();
  });

  it('adopts a full refund made in the dashboard instead of sending a second one', async () => {
    const { orderId, intentId } = await captured();
    const outside = gateway.outOfBandRefund(intentId);
    const admin = testId();
    const before = await counted();

    await refund(orderId, admin).expect(200, { outcome: 'REFUNDED' });

    expect(gateway.refundsOf(intentId).map((stripeRefund) => stripeRefund.id)).toEqual([outside]);
    expect(await readRefund(app, orderId)).toMatchObject({
      providerRefundId: outside,
      requestedBy: admin,
      status: 'SUCCEEDED',
    });
    expect((await counted()).owed).toBe(before.owed);
  });

  it.each([
    ['no admin', {}],
    ['an admin id that is not routable', { requestedBy: '42' }],
    ['an admin id sent as a number', { requestedBy: 137_465_797_020_397 }],
    ['an unknown field', { requestedBy: '137465797020397182', amountMinor: 1 }],
  ])('refuses a refund with %s (400) before touching the order', async (_case, body) => {
    const { orderId, intentId } = await captured();

    await internalPost(app, paymentRoutes.refund(orderId)).send(body).expect(400);

    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
    expect(gateway.refundsOf(intentId)).toHaveLength(0);
  });

  it('answers 503 with Retry-After while Stripe is down, and finishes the refund once it is back', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefundCalls(intentId);

    const res = await refund(orderId).expect(503);

    expect(res.headers['retry-after']).toBe('1');
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDING' });

    gateway.restoreRefundCalls(intentId);
    await refund(orderId).expect(200, { outcome: 'REFUNDED' });
    expect(gateway.refundsOf(intentId)).toHaveLength(1);
  });
});
