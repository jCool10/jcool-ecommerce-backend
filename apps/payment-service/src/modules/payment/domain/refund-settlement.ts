import { PaymentOrderStatus } from './payment-order-status';
import { PaymentRefundStatus } from './payment-refund-status';

export type ReportedRefundStatus = 'succeeded' | 'pending' | 'requires_action' | 'failed' | 'canceled';

/** What Stripe says about the refund, read back from Stripe itself, never taken from a webhook body. */
export interface ReportedRefund {
  /** Null for a refusal that never became a refund, or an adoption several refunds cover. */
  refundId: string | null;
  status: ReportedRefundStatus;
  failureReason: string | null;
  /** The refunds made elsewhere that together cover the charge, when `refundId` is null for that reason. */
  coveredBy?: readonly string[];
}

export interface RecordedRefund {
  status: PaymentRefundStatus;
  providerRefundId: string | null;
  /** Non-empty only when refunds made elsewhere were adopted together; `providerRefundId` is then null. */
  coveredRefundIds: readonly string[];
  failureReason: string | null;
}

export interface RefundSettlement {
  outcome: 'REFUNDED' | 'PENDING' | 'REFUND_FAILED';
  /** Present only when the header moves. */
  header?: PaymentOrderStatus;
  /** Present only when the row changes. */
  refund?: {
    status: PaymentRefundStatus;
    providerRefundId?: string;
    coveredRefundIds?: string[];
    failureReason: string | null;
  };
  /** True exactly once per refund: on the move that leaves the buyer's money with nobody returning it. */
  owed: boolean;
  reason?: string;
}

const FAILED_REPORTS: ReadonlySet<ReportedRefundStatus> = new Set(['failed', 'canceled']);

/**
 * The one place refund state moves, for the command and the webhook alike, under the header lock.
 * Settled states only move forward: a stale `pending` never undoes a success, and a failure is final.
 */
export function settleRefund(
  header: PaymentOrderStatus,
  row: RecordedRefund,
  report: ReportedRefund,
): RefundSettlement {
  const foreign = row.providerRefundId !== null && report.refundId !== null && report.refundId !== row.providerRefundId;
  // One refund of a covering set: it speaks for itself only, so its success settles nothing.
  const oneOfCovering = row.coveredRefundIds.length > 0 && report.refundId !== null;
  const failed = FAILED_REPORTS.has(report.status);

  switch (header) {
    case PaymentOrderStatus.REFUND_FAILED:
      return { outcome: 'REFUND_FAILED', owed: false, ...reasonOf(row.failureReason) };
    case PaymentOrderStatus.REFUNDED:
      // A refusal never became a refund, so it cannot be the late failure of one that succeeded.
      return failed && report.refundId !== null && !foreign ? fail(row, report) : { outcome: 'REFUNDED', owed: false };
    case PaymentOrderStatus.REFUNDING: {
      if (foreign) return { outcome: 'PENDING', owed: false };
      if (failed) return fail(row, report);
      if (report.status === 'succeeded' && !oneOfCovering) {
        return {
          outcome: 'REFUNDED',
          header: PaymentOrderStatus.REFUNDED,
          refund: { status: PaymentRefundStatus.SUCCEEDED, ...bindingOf(row, report), failureReason: null },
          owed: false,
        };
      }
      const binding = oneOfCovering ? {} : bindingOf(row, report);
      const learned = binding.providerRefundId !== undefined && row.providerRefundId === null;
      return learned || binding.coveredRefundIds !== undefined
        ? { outcome: 'PENDING', refund: { status: row.status, ...binding, failureReason: null }, owed: false }
        : { outcome: 'PENDING', owed: false };
    }
    default:
      throw new Error(`a refund row under a ${header} header`);
  }
}

function fail(row: RecordedRefund, report: ReportedRefund): RefundSettlement {
  const reason = report.failureReason ?? report.status;
  return {
    outcome: 'REFUND_FAILED',
    header: PaymentOrderStatus.REFUND_FAILED,
    refund: { status: PaymentRefundStatus.FAILED, ...bindingOf(row, report), failureReason: reason },
    owed: true,
    reason,
  };
}

/** Which Stripe refund the row stands for: one id, or the set of refunds that cover the charge. */
function bindingOf(
  row: RecordedRefund,
  report: ReportedRefund,
): { providerRefundId?: string; coveredRefundIds?: string[] } {
  if (row.coveredRefundIds.length > 0) return {};
  if (report.coveredBy?.length && row.providerRefundId === null) return { coveredRefundIds: [...report.coveredBy] };
  const id = row.providerRefundId ?? report.refundId;
  return id === null ? {} : { providerRefundId: id };
}

function reasonOf(reason: string | null): { reason?: string } {
  return reason === null ? {} : { reason };
}
