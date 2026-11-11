import type { SagaWriteResult } from '../../application/ports/order-repository.port';
import type { PaymentRefundOutcome } from '../../application/ports/order-payment-participant.port';
import type { CommitOutcome } from '../../domain/checkout-saga';

// Shared by the workflow bundle, the worker and the client; type imports only, so the workflow
// sandbox loads nothing from here.

export const REFUND_ORDER_WORKFLOW = 'RefundOrder';

export const refundOrderWorkflowId = (orderId: string): string => `refund-${orderId}`;

/** ApplicationFailure type of a participant answer the refund cannot act on; retried until fixed by hand. */
export const REFUND_CONFLICT_FAILURE = 'RefundConflict';

/** Snapshotted from config when the run starts; the workflow never reads env. */
export interface RefundOrderSettings {
  activityTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  pendingPollBaseMs: number;
  pendingPollMaxMs: number;
}

/** `requestedBy` is the admin's user id, from the verified token. */
export interface RefundOrderInput {
  orderId: string;
  requestedBy: string;
  settings: RefundOrderSettings;
}

/** `requestedBy` is the admin whose run this is, so a caller who joined it can tell. */
export type RefundOrderResult =
  | { outcome: 'REFUNDED'; requestedBy: string }
  | { outcome: 'REFUND_FAILED'; reason: string | null; requestedBy: string }
  | { outcome: 'NOT_REFUNDABLE'; requestedBy: string };

/**
 * `resumed`: the order was already REFUNDING, a run before this one started it. The last two end
 * the run at once.
 */
export type BeginRefundOutcome = 'started' | 'resumed' | 'already_refunded' | 'not_refundable';

/** What the run acts on; NOT_REFUNDABLE never comes back, it is thrown as a conflict. */
export interface RefundPaymentAnswer {
  outcome: Exclude<PaymentRefundOutcome, 'NOT_REFUNDABLE'>;
  reason?: string;
}

/**
 * Registered on the checkout saga's worker beside its activities, so no name may collide with
 * theirs. Business outcomes are returned; a transient fault or a conflict is thrown and retried.
 */
export interface RefundOrderActivityFunctions {
  beginRefund(input: { orderId: string }): Promise<BeginRefundOutcome>;
  refundPayment(input: { orderId: string; requestedBy: string }): Promise<RefundPaymentAnswer>;
  restockRefundedOrder(input: { orderId: string }): Promise<Exclude<CommitOutcome, 'CONFLICT'>>;
  abandonRefund(input: { orderId: string }): Promise<SagaWriteResult>;
  completeRefund(input: { orderId: string; requestedBy: string }): Promise<SagaWriteResult>;
}
