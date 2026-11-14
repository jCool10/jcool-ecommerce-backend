import { log, proxyActivities, sleep } from '@temporalio/workflow';
import type { RefundOrderActivityFunctions, RefundOrderInput, RefundOrderResult } from '../refund-order.contract';

// Money first, then stock: a refund the provider fails leaves nothing to undo, and the order goes
// back to PAID. Every activity retries until it lands, so each step only ever finishes by succeeding.
// A refund the provider holds is asked about again with backoff; the payment-service re-reads Stripe
// on every ask, and its webhook usually settles the refund before the next one.

export async function RefundOrder(input: RefundOrderInput): Promise<RefundOrderResult> {
  const { orderId, requestedBy, settings } = input;
  // No maximumAttempts: unset is unlimited (the SDK rejects 0).
  const activities = proxyActivities<RefundOrderActivityFunctions>({
    startToCloseTimeout: settings.activityTimeoutMs,
    retry: { initialInterval: settings.retryBaseMs, backoffCoefficient: 2, maximumInterval: settings.retryCapMs },
  });

  const begun = await activities.beginRefund({ orderId });
  if (begun === 'already_refunded') return { outcome: 'REFUNDED', requestedBy };
  if (begun === 'not_refundable') return { outcome: 'NOT_REFUNDABLE', requestedBy };

  for (let waitMs = settings.pendingPollBaseMs; ; waitMs = Math.min(waitMs * 2, settings.pendingPollMaxMs)) {
    const answer = await activities.refundPayment({ orderId, requestedBy });
    if (answer.outcome === 'REFUND_FAILED') {
      const written = await activities.abandonRefund({ orderId });
      if (written === 'stale') log.warn('refund abandon found the order elsewhere', { orderId });
      return { outcome: 'REFUND_FAILED', reason: answer.reason ?? null, requestedBy };
    }
    if (answer.outcome !== 'PENDING') break;
    await sleep(waitMs);
  }

  await activities.restockRefundedOrder({ orderId });
  const written = await activities.completeRefund({ orderId, requestedBy });
  if (written === 'stale') log.warn('refund completion found the order elsewhere', { orderId });
  return { outcome: 'REFUNDED', requestedBy };
}
