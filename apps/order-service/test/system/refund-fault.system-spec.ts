import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectCheckoutInvariants } from './checkout-invariants';
import { metricSum } from './checkout-observers';
import { checkoutScenarios, type PaidOrder } from './checkout-scenarios';
import { type Buyer, CheckoutStack, expectStatus, type HttpResult, waitFor } from './checkout-stack';
import { type AppService, SAGA_TIMINGS } from './checkout-stack-env';
import type { IntentStats } from './fake-stripe';

const CONVERGE_MS = 30_000;
// An activity left running by a dead worker times out (11s) before it is retried, and a participant's
// breaker may be open for a while after the fault on top of that.
const REFUND_SETTLE_MS = 60_000;

describe('admin refunds across every service, under real faults', () => {
  let stack: CheckoutStack;

  beforeAll(async () => {
    stack = await CheckoutStack.start();
  });

  afterAll(() => stack?.stop());

  afterEach(() => stack.restore());

  // --- scenario helpers ------------------------------------------------------------------------

  const { awaitingAuthorization, paidOrder, outboxIds, paymentRow, onHand, refundMails, expectOneRefundMail } =
    checkoutScenarios(() => stack);

  interface RefundCase extends PaidOrder {
    admin: Buyer;
    /** The SKU's on-hand before the order was placed, which a refund must bring it back to. */
    onHandBefore: number;
  }

  async function paidForRefund(): Promise<RefundCase> {
    const skuId = stack.skus[0];
    const onHandBefore = await onHand(skuId);
    const order = await paidOrder(skuId);
    return { ...order, onHandBefore, admin: await stack.admin() };
  }

  const metric = async (service: AppService, name: string, where?: (labels: Record<string, string>) => boolean) =>
    metricSum(await stack.scrapeMetrics(service), name, where);
  const refundsOwed = () =>
    metric('payment-service', 'payment_refund_owed_total', (labels) => labels.source === 'refund_failed');
  const untrackedRefunds = () => metric('payment-service', 'payment_refund_untracked_total');
  const refundStats = (intentId: string) => stack.stripe.intentStats(intentId);
  const keySuffixes = (keys: string[]) => keys.map((key) => key.slice(key.lastIndexOf(':')));

  const expectAnswered = (res: HttpResult, statuses: number[]) =>
    expect(statuses, `${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);

  async function inboxClaims(messageId: string): Promise<number> {
    const [{ count }] = await stack.sql<{ count: number }>(
      'orders',
      `select count(*)::int as count from inbox where consumer = 'order-events' and message_id = $1`,
      [messageId],
    );
    return count;
  }

  /**
   * The money back once and in full, the stock back once, the actor on every record the shop keeps,
   * and one mail. `shopRefund` false: the refund at Stripe was made elsewhere and carries no metadata.
   */
  async function expectRefundedOnce(
    order: RefundCase,
    { actor = order.admin.userId, shopRefund = true }: { actor?: string; shopRefund?: boolean } = {},
  ): Promise<IntentStats> {
    await stack.waitForOrderStatus(order.orderId, 'REFUNDED', REFUND_SETTLE_MS);
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUNDED');
    expect(await stack.inventoryHeader(order.orderId)).toBe('RESTOCKED');
    expect(await onHand(order.skuId)).toBe(order.onHandBefore);

    const stats = await refundStats(order.intentId);
    expect(stats).toMatchObject({ refundsCreated: 1, refundedAmount: order.amount });
    if (shopRefund) {
      expect(stats.refunds[0].metadata).toEqual({ order_id: order.orderId, requested_by: actor });
    }
    expect(await stack.paymentRefund(order.orderId)).toMatchObject({
      status: 'SUCCEEDED',
      amount_minor: order.amount,
      requested_by: actor,
    });
    expect(await stack.outboxPayloads(order.orderId, 'order.refunded')).toMatchObject([
      { orderId: order.orderId, requestedBy: actor, totalAmountMinor: order.amount },
    ]);
    await expectOneRefundMail(order.buyer.email);
    return stats;
  }

  // --- the happy path --------------------------------------------------------------------------

  it('refunds a paid order once: the money, then the stock, the admin on every record, one mail', async () => {
    const order = await paidForRefund();

    const res = expectStatus(await stack.refund(order.admin, order.orderId), 200);

    expect(res.body.status).toBe('REFUNDED');
    const stats = await expectRefundedOnce(order);
    expect(stats.refundRequests).toBe(1);
    expect(keySuffixes(stats.refundKeys)).toEqual([':0']);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('refunds once for ten concurrent calls from two admins and for the calls after it', async () => {
    const order = await paidForRefund();
    const admins = [order.admin, await stack.admin()];

    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => stack.refund(admins[i % 2], order.orderId)));
    for (const res of answers) expectAnswered(res, [200, 202]);
    await stack.waitForOrderStatus(order.orderId, 'REFUNDED', CONVERGE_MS);
    for (const admin of admins) {
      expect(expectStatus(await stack.refund(admin, order.orderId), 200).body.status).toBe('REFUNDED');
    }

    // Whichever call started the run is the actor, on every record alike.
    const actor = (await stack.paymentRefund(order.orderId))?.requested_by as string;
    expect(admins.map((admin) => admin.userId)).toContain(actor);
    await expectRefundedOnce(order, { actor });
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  // --- Stripe misbehaving ----------------------------------------------------------------------

  it('takes a refund Stripe applied before answering 500 as done, found by intent, under the same key', async () => {
    const order = await paidForRefund();
    const generation = (await paymentRow(order.orderId)).stripe_key_gen;
    await stack.setStripeFault({ mode: 'apply_then_500', target: 'refund' });

    expectAnswered(await stack.refund(order.admin, order.orderId), [200, 202]);

    const stats = await expectRefundedOnce(order);
    expect(await stack.stripe.faultsFired()).toEqual({ 'apply_then_500:refund': 1 });
    expect(keySuffixes(stats.refundKeys)).toEqual([`:${generation}`]);
    expect((await paymentRow(order.orderId)).stripe_key_gen).toBe(generation);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('moves to a new key after each 500 Stripe stored under the old one, and refunds once', async () => {
    const order = await paidForRefund();
    const generation = (await paymentRow(order.orderId)).stripe_key_gen;
    await stack.setStripeFault({ mode: '500', target: 'refund', times: 3 });

    expectAnswered(await stack.refund(order.admin, order.orderId), [200, 202]);

    const stats = await expectRefundedOnce(order);
    expect(await stack.stripe.faultsFired()).toEqual({ '500:refund': 3 });
    expect(keySuffixes(stats.refundKeys)).toEqual([0, 1, 2, 3].map((n) => `:${generation + n}`));
    expect((await paymentRow(order.orderId)).stripe_key_gen).toBe(generation + 3);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('answers 202 for a refund Stripe holds as pending, then finishes it once Stripe settles it', async () => {
    const order = await paidForRefund();
    await stack.setStripeFault({ mode: 'pending', target: 'refund' });

    const res = expectStatus(await stack.refund(order.admin, order.orderId), 202);

    expect(res.body.status).toBe('REFUNDING');
    const [pending] = (await refundStats(order.intentId)).refunds;
    expect(pending.status).toBe('pending');
    expect(await stack.paymentRefund(order.orderId)).toMatchObject({
      status: 'PENDING',
      provider_refund_id: pending.id,
    });
    const { webhook } = await stack.stripe.settleRefund(pending.id, { status: 'succeeded', deliverWebhook: true });
    expect(webhook?.status).toBe(200);
    await stack.waitForPaymentHeader(order.orderId, 'REFUNDED');
    await expectRefundedOnce(order);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('puts the order back to PAID when Stripe fails the refund, counts it owed, and mails nothing', async () => {
    const order = await paidForRefund();
    const owedBefore = await refundsOwed();
    await stack.setStripeFault({ mode: 'pending', target: 'refund' });
    expectStatus(await stack.refund(order.admin, order.orderId), 202);
    const [pending] = (await refundStats(order.intentId)).refunds;

    await stack.stripe.settleRefund(pending.id, { status: 'failed', deliverWebhook: true });
    await stack.waitForOrderStatus(order.orderId, 'PAID', CONVERGE_MS);
    const again = await stack.refund(order.admin, order.orderId);

    expect(again.status).toBe(409);
    expect(again.body.message).toEqual({ code: 'REFUND_FAILED', reason: 'expired_or_canceled_card' });
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUND_FAILED');
    expect(await stack.paymentRefund(order.orderId)).toMatchObject({
      status: 'FAILED',
      failure_reason: 'expired_or_canceled_card',
    });
    expect(await stack.inventoryHeader(order.orderId)).toBe('COMMITTED');
    expect(await onHand(order.skuId)).toBe(order.onHandBefore - 1);
    expect(await refundsOwed()).toBe(owedBefore + 1);
    expect(await refundStats(order.intentId)).toMatchObject({ refundsCreated: 1, refundedAmount: 0 });
    expect(await stack.outboxPayloads(order.orderId, 'order.refunded')).toEqual([]);
    expect(await refundMails(order.buyer.email)).toEqual([]);
    // The second call ran the refund again and found the payment-service's answer already written.
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'PAID', refundRuns: 2 }]);
  });

  // --- refunds made outside the shop -----------------------------------------------------------

  it('binds a dashboard refund with no metadata to its order by intent, then adopts it instead of refunding twice', async () => {
    const order = await paidForRefund();
    const [owedBefore, untrackedBefore] = [await refundsOwed(), await untrackedRefunds()];

    const { refundId, webhook } = await stack.stripe.refundOutOfBand(order.intentId);
    expect(webhook?.status).toBe(200);
    await waitFor(untrackedRefunds, (n) => n === untrackedBefore + 1, CONVERGE_MS, 'untracked refund counted');
    expect(await stack.paymentHeader(order.orderId)).toBe('CAPTURED');
    expect(await stack.paymentRefund(order.orderId)).toBeUndefined();

    expectStatus(await stack.refund(order.admin, order.orderId), 200);

    const stats = await expectRefundedOnce(order, { shopRefund: false });
    expect(stats.refunds).toEqual([{ id: refundId, amount: order.amount, status: 'succeeded', metadata: {} }]);
    expect(stats.refundRequests).toBe(1);
    expect(await stack.paymentRefund(order.orderId)).toMatchObject({ provider_refund_id: refundId });
    expect(await refundsOwed()).toBe(owedBefore);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('fails the shop refund of a charge partly refunded in the dashboard, leaving it PAID with the rest owed', async () => {
    const order = await paidForRefund();
    const [owedBefore, untrackedBefore] = [await refundsOwed(), await untrackedRefunds()];
    const partial = Math.floor(order.amount / 2);

    await stack.stripe.refundOutOfBand(order.intentId, { amount: partial });
    await waitFor(untrackedRefunds, (n) => n === untrackedBefore + 1, CONVERGE_MS, 'untracked refund counted');
    const res = await stack.refund(order.admin, order.orderId);

    expect(res.status).toBe(409);
    expect(res.body.message).toEqual({ code: 'REFUND_FAILED', reason: 'amount_too_large' });
    expect(await stack.orderStatus(order.orderId)).toBe('PAID');
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUND_FAILED');
    expect(await stack.inventoryHeader(order.orderId)).toBe('COMMITTED');
    expect(await onHand(order.skuId)).toBe(order.onHandBefore - 1);
    expect(await refundsOwed()).toBe(owedBefore + 1);
    expect(await refundStats(order.intentId)).toMatchObject({
      refundRequests: 1,
      refundsCreated: 1,
      refundedAmount: partial,
    });
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'PAID', refundRuns: 1 }]);
  });

  // --- outages ---------------------------------------------------------------------------------

  it('finishes a refund whose admin call met Temporal going down, once Temporal is back', async () => {
    const order = await paidForRefund();
    // Holds the run inside its Stripe call long enough to take Temporal away under it.
    await stack.setStripeFault({ mode: 'slow', target: 'refund', ms: 3_000 });

    const call = stack.refund(order.admin, order.orderId);
    await stack.waitForPaymentHeader(order.orderId, 'REFUNDING', 10_000);
    await stack.stopService('temporal');

    expectAnswered(await call, [202, 503]);
    expect(await stack.orderStatus(order.orderId)).toBe('REFUNDING');
    await stack.startService('temporal');
    await stack.waitForSagaWorker();

    const stats = await expectRefundedOnce(order);
    expect(stats.refundKeys).toHaveLength(1);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('returns the money, retries the restock through an inventory outage, and restocks once', async () => {
    const order = await paidForRefund();
    await stack.addToxic('order-to-inventory', { type: 'timeout', stream: 'upstream', attributes: { timeout: 0 } });

    const res = expectStatus(await stack.refund(order.admin, order.orderId), 202);

    expect(res.body.status).toBe('REFUNDING');
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUNDED');
    expect(await stack.inventoryHeader(order.orderId)).toBe('COMMITTED');
    await stack.clearToxics();
    await expectRefundedOnce(order);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('resumes under the same key when the payment-service dies with its Stripe call open', async () => {
    const order = await paidForRefund();
    // Every call hangs until the fault is cleared, so the kill lands between the header flip and a refund.
    await stack.setStripeFault({ mode: 'hang', target: 'refund', times: 1_000, ms: 60_000 });

    const call = stack.refund(order.admin, order.orderId);
    await waitFor(
      () => refundStats(order.intentId),
      (stats) => stats.refundRequests >= 1,
      10_000,
      'refund call at Stripe',
    );
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUNDING');
    await stack.killService('payment-service');
    await stack.stripe.clearFaults();
    await stack.startService('payment-service');

    expectAnswered(await call, [200, 202]);
    const stats = await expectRefundedOnce(order);
    expect(stats.refundKeys).toHaveLength(1);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('finishes a refund whose worker was killed while Stripe was refunding', async () => {
    const order = await paidForRefund();
    await stack.setStripeFault({ mode: 'slow', target: 'refund', ms: 3_000 });

    const call = stack.refund(order.admin, order.orderId);
    await stack.waitForPaymentHeader(order.orderId, 'REFUNDING', 10_000);
    await stack.killService('order-service');

    expect([502, 503]).toContain((await call).status);
    await stack.startService('order-service');
    const stats = await expectRefundedOnce(order);
    expect(stats.refundKeys).toHaveLength(1);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('restocks once when the worker is killed after the inventory-service applied the restock', async () => {
    const order = await paidForRefund();
    const idempotentBefore = await metric(
      'inventory-service',
      'tcc_branch_total',
      (labels) => labels.op === 'restock' && labels.outcome === 'idempotent',
    );
    // The answer held back, so the restock has landed while its activity is still waiting on it.
    await stack.addToxic('order-to-inventory', {
      type: 'latency',
      stream: 'downstream',
      attributes: { latency: SAGA_TIMINGS.inventoryCommandTimeoutMs - 500 },
    });

    const call = stack.refund(order.admin, order.orderId);
    await stack.waitForInventoryHeader(order.orderId, 'RESTOCKED', 15_000);
    await stack.killService('order-service');

    expect([502, 503]).toContain((await call).status);
    await stack.clearToxics();
    await stack.startService('order-service');
    await expectRefundedOnce(order);
    expect(
      await metric(
        'inventory-service',
        'tcc_branch_total',
        (labels) => labels.op === 'restock' && labels.outcome === 'idempotent',
      ),
    ).toBeGreaterThan(idempotentBefore);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  // --- after the refund ------------------------------------------------------------------------

  it('closes a payment.authorized delivered again after the refund without voiding or conflicting', async () => {
    const order = await paidForRefund();
    expectStatus(await stack.refund(order.admin, order.orderId), 200);
    await expectRefundedOnce(order);
    const compensations = () => metric('order-service', 'saga_compensation_total');
    const conflicts = () => metric('order-service', 'saga_step_total', (labels) => labels.outcome === 'conflict');
    const [compensationsBefore, conflictsBefore] = [await compensations(), await conflicts()];

    const [authorized] = await outboxIds('payment', 'payment.authorized', order.orderId);
    const again = await stack.republish('payment', authorized);
    await waitFor(
      () => inboxClaims(again),
      (claims) => claims === 1,
      CONVERGE_MS,
      'second payment.authorized claimed',
    );

    // The late run reads the order, finds the money kept, and closes: two closed runs, nothing voided.
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED', runs: 2 }]);
    expect((await refundStats(order.intentId)).voids).toBe(0);
    expect(await stack.paymentHeader(order.orderId)).toBe('REFUNDED');
    expect(await compensations()).toBe(compensationsBefore);
    expect(await conflicts()).toBe(conflictsBefore);
  });

  it('loses the refund mail rather than sending it twice when the mail server drops it', async () => {
    const order = await paidForRefund();
    const mailFailures = () =>
      metric('order-service', 'mail_send_failures_total', (labels) => labels.kind === 'order_refunded');
    const failuresBefore = await mailFailures();
    await stack.addToxic('order-to-smtp', { type: 'timeout', stream: 'downstream', attributes: { timeout: 100 } });

    expectStatus(await stack.refund(order.admin, order.orderId), 200);
    await waitFor(mailFailures, (n) => n === failuresBefore + 1, CONVERGE_MS, 'refund mail failure counted');
    await stack.clearToxics();

    const [refunded] = await stack.sql<{ id: string }>(
      'orders',
      `select id::text from outbox where event_type = 'order.refunded' and aggregate_id = $1`,
      [order.orderId],
    );
    const [job] = await waitFor(
      async () =>
        (await stack.queueJobs('order-events', 'order.refunded')).filter((j) => j.data.outboxId === refunded.id),
      (jobs) => jobs[0]?.finishedOn !== undefined,
      CONVERGE_MS,
      'order.refunded finished',
    );
    expect(job.failedReason).toBeUndefined();
    expect(await inboxClaims(refunded.id)).toBe(1);
    expect(await refundMails(order.buyer.email)).toEqual([]);
    expect(await mailFailures()).toBe(failuresBefore + 1);
    await expectCheckoutInvariants(stack, [{ orderId: order.orderId, status: 'REFUNDED' }]);
  });

  it('refuses to refund an order that was never paid, without calling Stripe or the stock', async () => {
    const admin = await stack.admin();
    const pending = await awaitingAuthorization();

    expect((await stack.refund(admin, pending.orderId)).status).toBe(409);
    expectStatus(await stack.cancel(pending.buyer, pending.orderId), 200);
    expect((await stack.refund(admin, pending.orderId)).status).toBe(409);

    const sku = stack.skus[stack.skus.length - 1];
    const seeded = await onHand(sku);
    const emptied = await stack.sql(
      'inventory',
      'update stock_levels set quantity_on_hand = 0 where variant_id = $1 and quantity_reserved = 0 returning id',
      [sku],
    );
    expect(emptied).toHaveLength(1);
    try {
      const buyer = await stack.buyer(sku);
      expect((await stack.checkout(buyer)).status).toBe(409);
      const [rejected] = await stack.sql<{ id: string }>('orders', 'select id::text from orders where user_id = $1', [
        buyer.userId,
      ]);
      await stack.waitForOrderStatus(rejected.id, 'REJECTED', CONVERGE_MS);
      expect((await stack.refund(admin, rejected.id)).status).toBe(409);

      const { byPi } = await stack.stripe.stats();
      expect(Object.values(byPi).reduce((sum, stats) => sum + stats.refundRequests, 0)).toBe(0);
      await expectCheckoutInvariants(stack, [
        { orderId: pending.orderId, status: 'CANCELLED' },
        { orderId: rejected.id, status: 'REJECTED' },
      ]);
    } finally {
      await stack.sql('inventory', 'update stock_levels set quantity_on_hand = $2 where variant_id = $1', [
        sku,
        seeded,
      ]);
    }
  });

  // Last on purpose: the violation it leaves would otherwise sit in the checker's window for a day.
  it('reports a refund Stripe fails after the order was refunded, and counts it owed', async () => {
    const order = await paidForRefund();
    expectStatus(await stack.refund(order.admin, order.orderId), 200);
    await expectRefundedOnce(order);
    const owedBefore = await refundsOwed();
    const [refund] = (await refundStats(order.intentId)).refunds;

    try {
      const { webhook } = await stack.stripe.settleRefund(refund.id, { status: 'failed', deliverWebhook: true });

      expect(webhook?.status).toBe(200);
      await stack.waitForPaymentHeader(order.orderId, 'REFUND_FAILED');
      expect(await refundsOwed()).toBe(owedBefore + 1);
      expect(await stack.orderStatus(order.orderId)).toBe('REFUNDED');
      await expectCheckoutInvariants(stack, [
        { orderId: order.orderId, status: 'REFUNDED', violations: ['refunded_without_refund'] },
      ]);
    } finally {
      // Out of the checker's window, so a scenario run after this one starts from a clean report.
      await stack.sql('orders', `update orders set finalized_at = finalized_at - interval '2 days' where id = $1`, [
        order.orderId,
      ]);
    }
  });
});
