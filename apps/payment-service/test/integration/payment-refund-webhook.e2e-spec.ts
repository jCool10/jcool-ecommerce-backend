import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { paymentRoutes } from '@jcool/internal-contracts';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authorizeSession, postWebhook, readPaymentOrder, readRefund } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  internalPost,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { scrapeMetrics } from '../setup/metrics.helper';
import { refundEvent, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_refund_webhook_secret01';
const AMOUNT = 150_000;

describe('Refund webhooks (integration, real Postgres, real HMAC, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function captured() {
    const orderId = testId();
    const { body } = await internalPost(app, paymentRoutes.session(orderId))
      .send({ amountMinor: AMOUNT, currency: 'VND', expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      .expect(200);
    const intentId = await authorizeSession(app, body.providerSessionId, orderId);
    await internalPost(app, paymentRoutes.capture(orderId)).expect(200, { outcome: 'CAPTURED' });
    return { orderId, intentId };
  }

  const refund = (orderId: string) => internalPost(app, paymentRoutes.refund(orderId)).send({ requestedBy: testId() });

  const deliver = (event: Record<string, unknown>) => postWebhook(app, signWebhook({ secret: WEBHOOK_SECRET, event }));

  const eventRow = async (providerEventId: string) =>
    db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.providerEventId, providerEventId));

  const counted = async () => {
    const scrape = await scrapeMetrics(app);
    return {
      owed: scrape.value('payment_refund_owed_total', { source: 'refund_failed' }) ?? 0,
      untracked: scrape.value('payment_refund_untracked_total') ?? 0,
    };
  };

  it('settles a pending refund from what Stripe reads back, once however often it is delivered', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_pending');
    await refund(orderId).expect(202, { outcome: 'PENDING' });
    const [pending] = gateway.refundsOf(intentId);
    gateway.settleRefund(pending.id, 'succeeded');
    const event = refundEvent('refund.updated', pending.id);

    await deliver(event).expect(200);
    await deliver(event).expect(200);

    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDED' });
    expect(await readRefund(app, orderId)).toMatchObject({ providerRefundId: pending.id, status: 'SUCCEEDED' });
    expect(await eventRow(event.id as string)).toEqual([expect.objectContaining({ status: 'PROCESSED' })]);
    await refund(orderId).expect(200, { outcome: 'IDEMPOTENT' });
  });

  it('ignores a body claiming success while Stripe still holds the refund as pending', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_pending');
    await refund(orderId).expect(202);
    const [pending] = gateway.refundsOf(intentId);

    await deliver(refundEvent('refund.updated', pending.id)).expect(200);

    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDING' });
    expect(await readRefund(app, orderId)).toMatchObject({ status: 'PENDING' });
  });

  it('moves a refund Stripe fails after reporting it done to REFUND_FAILED, owed once', async () => {
    const { orderId, intentId } = await captured();
    await refund(orderId).expect(200, { outcome: 'REFUNDED' });
    const [done] = gateway.refundsOf(intentId);
    const before = await counted();
    gateway.settleRefund(done.id, 'failed');

    await deliver(refundEvent('refund.failed', done.id)).expect(200);
    await deliver(refundEvent('refund.updated', done.id)).expect(200);

    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUND_FAILED' });
    expect(await readRefund(app, orderId)).toMatchObject({
      status: 'FAILED',
      failureReason: 'expired_or_canceled_card',
    });
    expect((await counted()).owed).toBe(before.owed + 1);
    await refund(orderId).expect(409, { outcome: 'REFUND_FAILED', reason: 'expired_or_canceled_card' });
  });

  it('fails an order refunded by several dashboard refunds when one of them fails later, owed once', async () => {
    const { orderId, intentId } = await captured();
    const covering = [gateway.outOfBandRefund(intentId, 100_000), gateway.outOfBandRefund(intentId, 50_000)];
    await refund(orderId).expect(200, { outcome: 'REFUNDED' });
    expect(await readRefund(app, orderId)).toMatchObject({ providerRefundId: null, coveredRefundIds: covering });
    const before = await counted();
    gateway.settleRefund(covering[1], 'failed');

    await deliver(refundEvent('refund.failed', covering[1])).expect(200);

    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUND_FAILED' });
    expect(await readRefund(app, orderId)).toMatchObject({ status: 'FAILED', coveredRefundIds: covering });
    expect((await counted()).owed).toBe(before.owed + 1);
    expect(gateway.refundsOf(intentId)).toHaveLength(2);
  });

  it('counts a dashboard refund on a captured order, bound by its intent, and leaves the order captured', async () => {
    const { orderId, intentId } = await captured();
    const outside = gateway.outOfBandRefund(intentId);
    const before = await counted();
    const event = refundEvent('refund.created', outside);

    await deliver(event).expect(200);

    expect((await counted()).untracked).toBe(before.untracked + 1);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
    expect(await readRefund(app, orderId)).toBeUndefined();
    expect(await eventRow(event.id as string)).toEqual([expect.objectContaining({ status: 'SKIPPED' })]);
  });

  it('writes nothing for a refund on this charge whose metadata names another order', async () => {
    const { orderId, intentId } = await captured();
    const named = await gateway.refundIntent(
      { intentId, amountMinor: AMOUNT, currency: 'VND', orderId: testId(), requestedBy: testId() },
      'another-key-holder',
    );
    const before = await counted();
    const event = refundEvent('refund.created', named.refundId as string);

    await deliver(event).expect(200);

    expect(await counted()).toEqual(before);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
    expect(await readRefund(app, orderId)).toBeUndefined();
    expect(await eventRow(event.id as string)).toEqual([expect.objectContaining({ status: 'SKIPPED' })]);
  });

  it('answers 503 and logs nothing while Stripe cannot be asked, so its redelivery applies', async () => {
    const { orderId, intentId } = await captured();
    gateway.failRefund(intentId, 'refund_pending');
    await refund(orderId).expect(202);
    const [pending] = gateway.refundsOf(intentId);
    gateway.settleRefund(pending.id, 'succeeded');
    gateway.failRefundCalls(intentId);
    const event = refundEvent('refund.updated', pending.id);

    await deliver(event).expect(503);
    expect(await eventRow(event.id as string)).toEqual([]);

    gateway.restoreRefundCalls(intentId);
    await deliver(event).expect(200);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'REFUNDED' });
  });
});
