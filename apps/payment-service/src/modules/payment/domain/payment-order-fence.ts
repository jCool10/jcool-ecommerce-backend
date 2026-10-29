import type { PaymentOrderStatus } from './payment-order-status';

export type PaymentOrderOp = 'open_session' | 'capture' | 'cancel';

export interface PaymentOrderDecisions {
  /** `open` still has to match the header's amount. */
  open_session: 'open' | 'closed';
  capture: 'capture' | 'idempotent' | 'not_capturable' | 'conflict';
  /** `fence` inserts a FENCED header; `rescan` leaves the header and only re-settles the attempts under it. */
  cancel: 'fence' | 'cancel' | 'rescan' | 'captured_conflict';
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
  },
  capture: {
    NONE: 'conflict',
    OPEN: 'conflict',
    AUTHORIZED: 'capture',
    CAPTURED: 'idempotent',
    CANCELLED: 'not_capturable',
    FENCED: 'not_capturable',
  },
  cancel: {
    NONE: 'fence',
    OPEN: 'cancel',
    AUTHORIZED: 'cancel',
    CAPTURED: 'captured_conflict',
    CANCELLED: 'rescan',
    FENCED: 'rescan',
  },
};

/** What a TCC command may do given the order's header (`null` = no header yet). */
export function decidePaymentOrderOp<Op extends PaymentOrderOp>(
  op: Op,
  current: PaymentOrderStatus | null,
): PaymentOrderDecisions[Op] {
  return FENCE[op][current ?? 'NONE'];
}
