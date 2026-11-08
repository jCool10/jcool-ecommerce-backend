import type { PaymentOrderStatus } from './payment-order-status';

export type PaymentOrderOp = 'open_session' | 'capture' | 'cancel' | 'refund';

export interface PaymentOrderDecisions {
  /** `open` still has to match the header's amount. */
  open_session: 'open' | 'closed';
  capture: 'capture' | 'idempotent' | 'not_capturable' | 'conflict';
  /** `fence` inserts a FENCED header; `rescan` leaves the header and only re-settles the attempts under it. */
  cancel: 'fence' | 'cancel' | 'rescan' | 'captured_conflict';
  /** `resume` picks up the refund row an earlier call wrote, with its key and its actor. */
  refund: 'refund' | 'resume' | 'idempotent' | 'failed' | 'not_refundable';
}

type FenceTable = { [Op in PaymentOrderOp]: Record<PaymentOrderStatus | 'NONE', PaymentOrderDecisions[Op]> };

const FENCE: FenceTable = {
  open_session: {
    NONE: 'open',
    OPEN: 'open',
    AUTHORIZED: 'closed',
    CAPTURED: 'closed',
    CANCELLED: 'closed',
    FENCED: 'closed',
    REFUNDING: 'closed',
    REFUNDED: 'closed',
    REFUND_FAILED: 'closed',
  },
  // The money was captured under every refund header; the saga only captures before that.
  capture: {
    NONE: 'conflict',
    OPEN: 'conflict',
    AUTHORIZED: 'capture',
    CAPTURED: 'idempotent',
    CANCELLED: 'not_capturable',
    FENCED: 'not_capturable',
    REFUNDING: 'idempotent',
    REFUNDED: 'idempotent',
    REFUND_FAILED: 'idempotent',
  },
  cancel: {
    NONE: 'fence',
    OPEN: 'cancel',
    AUTHORIZED: 'cancel',
    CAPTURED: 'captured_conflict',
    CANCELLED: 'rescan',
    FENCED: 'rescan',
    REFUNDING: 'captured_conflict',
    REFUNDED: 'captured_conflict',
    REFUND_FAILED: 'captured_conflict',
  },
  refund: {
    NONE: 'not_refundable',
    OPEN: 'not_refundable',
    AUTHORIZED: 'not_refundable',
    CAPTURED: 'refund',
    CANCELLED: 'not_refundable',
    FENCED: 'not_refundable',
    REFUNDING: 'resume',
    REFUNDED: 'idempotent',
    REFUND_FAILED: 'failed',
  },
};

/** What a TCC command may do given the order's header (`null` = no header yet). */
export function decidePaymentOrderOp<Op extends PaymentOrderOp>(
  op: Op,
  current: PaymentOrderStatus | null,
): PaymentOrderDecisions[Op] {
  return FENCE[op][current ?? 'NONE'];
}
