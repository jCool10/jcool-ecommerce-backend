import { describe, expect, it } from 'vitest';
import { decidePaymentOrderOp, type PaymentOrderDecisions, type PaymentOrderOp } from './payment-order-fence';
import { PAYMENT_ORDER_STATUSES, type PaymentOrderStatus } from './payment-order-status';

type Row = { [Op in PaymentOrderOp]: PaymentOrderDecisions[Op] };

const AFTER_CAPTURE = { open_session: 'closed', capture: 'idempotent', cancel: 'captured_conflict' } as const;

const TABLE: Record<PaymentOrderStatus | 'none', Row> = {
  none: { open_session: 'open', capture: 'conflict', cancel: 'fence', refund: 'not_refundable' },
  OPEN: { open_session: 'open', capture: 'conflict', cancel: 'cancel', refund: 'not_refundable' },
  AUTHORIZED: { open_session: 'closed', capture: 'capture', cancel: 'cancel', refund: 'not_refundable' },
  CAPTURED: { ...AFTER_CAPTURE, refund: 'refund' },
  CANCELLED: { open_session: 'closed', capture: 'not_capturable', cancel: 'rescan', refund: 'not_refundable' },
  FENCED: { open_session: 'closed', capture: 'not_capturable', cancel: 'rescan', refund: 'not_refundable' },
  REFUNDING: { ...AFTER_CAPTURE, refund: 'resume' },
  REFUNDED: { ...AFTER_CAPTURE, refund: 'idempotent' },
  REFUND_FAILED: { ...AFTER_CAPTURE, refund: 'failed' },
};

const CASES = (['none', ...PAYMENT_ORDER_STATUSES] as const).flatMap((status) =>
  (Object.keys(TABLE[status]) as PaymentOrderOp[]).map((op) => ({ status, op, expected: TABLE[status][op] })),
);

describe('decidePaymentOrderOp', () => {
  it('covers every operation against every header state', () => {
    expect(CASES).toHaveLength(36);
  });

  it.each(CASES)('$op on $status → $expected', ({ status, op, expected }) => {
    expect(decidePaymentOrderOp(op, status === 'none' ? null : status)).toBe(expected);
  });
});
