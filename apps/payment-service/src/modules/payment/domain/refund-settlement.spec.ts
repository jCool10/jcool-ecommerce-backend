import { describe, expect, it } from 'vitest';
import { PaymentOrderStatus } from './payment-order-status';
import { PaymentRefundStatus } from './payment-refund-status';
import { settleRefund, type RecordedRefund, type ReportedRefund, type ReportedRefundStatus } from './refund-settlement';

const { REFUNDING, REFUNDED, REFUND_FAILED } = PaymentOrderStatus;
const { PENDING, SUCCEEDED, FAILED } = PaymentRefundStatus;

const row = (
  status: PaymentRefundStatus,
  providerRefundId: string | null = 're_1',
  coveredRefundIds: string[] = [],
): RecordedRefund => ({
  status,
  providerRefundId,
  coveredRefundIds,
  failureReason: status === FAILED ? 'expired_or_canceled_card' : null,
});

const COVERING = ['re_a', 're_b'];

const reported = (status: ReportedRefundStatus, overrides: Partial<ReportedRefund> = {}): ReportedRefund => ({
  refundId: 're_1',
  status,
  failureReason: status === 'failed' ? 'insufficient_funds' : null,
  ...overrides,
});

describe('settleRefund', () => {
  it('settles a succeeded refund: header REFUNDED, row SUCCEEDED, nothing owed', () => {
    expect(settleRefund(REFUNDING, row(PENDING, null), reported('succeeded'))).toEqual({
      outcome: 'REFUNDED',
      header: REFUNDED,
      refund: { status: SUCCEEDED, providerRefundId: 're_1', failureReason: null },
      owed: false,
    });
  });

  it.each(['pending', 'requires_action'] as const)('keeps a %s refund pending, recording its id', (status) => {
    expect(settleRefund(REFUNDING, row(PENDING, null), reported(status))).toEqual({
      outcome: 'PENDING',
      refund: { status: PENDING, providerRefundId: 're_1', failureReason: null },
      owed: false,
    });
  });

  it('writes nothing for a pending refund it already holds the id of', () => {
    expect(settleRefund(REFUNDING, row(PENDING), reported('pending'))).toEqual({ outcome: 'PENDING', owed: false });
  });

  it.each(['failed', 'canceled'] as const)('fails a %s refund and counts the money as owed', (status) => {
    expect(settleRefund(REFUNDING, row(PENDING), reported(status, { failureReason: 'lost_or_stolen_card' }))).toEqual({
      outcome: 'REFUND_FAILED',
      header: REFUND_FAILED,
      refund: { status: FAILED, providerRefundId: 're_1', failureReason: 'lost_or_stolen_card' },
      owed: true,
      reason: 'lost_or_stolen_card',
    });
  });

  it('names a failure Stripe gave no reason for after its status', () => {
    expect(settleRefund(REFUNDING, row(PENDING), reported('canceled')).reason).toBe('canceled');
  });

  it('settles a refusal that never became a refund, keeping the row without a provider id', () => {
    const refusal = reported('failed', { refundId: null, failureReason: 'charge_disputed' });

    expect(settleRefund(REFUNDING, row(PENDING, null), refusal)).toEqual({
      outcome: 'REFUND_FAILED',
      header: REFUND_FAILED,
      refund: { status: FAILED, failureReason: 'charge_disputed' },
      owed: true,
      reason: 'charge_disputed',
    });
  });

  it('settles an adoption covered by several refunds, recording all of them and naming none', () => {
    const adoption = reported('succeeded', { refundId: null, coveredBy: COVERING });

    expect(settleRefund(REFUNDING, row(PENDING, null), adoption)).toEqual({
      outcome: 'REFUNDED',
      header: REFUNDED,
      refund: { status: SUCCEEDED, coveredRefundIds: COVERING, failureReason: null },
      owed: false,
    });
  });

  it('records the covering refunds of an adoption still pending at Stripe', () => {
    const adoption = reported('pending', { refundId: null, coveredBy: COVERING });

    expect(settleRefund(REFUNDING, row(PENDING, null), adoption)).toEqual({
      outcome: 'PENDING',
      refund: { status: PENDING, coveredRefundIds: COVERING, failureReason: null },
      owed: false,
    });
  });

  it('waits for the whole set when one covering refund succeeds while the refund is pending', () => {
    expect(settleRefund(REFUNDING, row(PENDING, null, COVERING), reported('succeeded', { refundId: 're_a' }))).toEqual({
      outcome: 'PENDING',
      owed: false,
    });
  });

  it.each([REFUNDING, REFUNDED])(
    'fails the refund under %s when one covering refund fails, owing the money',
    (header) => {
      const settled = header === REFUNDED ? SUCCEEDED : PENDING;

      expect(settleRefund(header, row(settled, null, COVERING), reported('failed', { refundId: 're_b' }))).toEqual({
        outcome: 'REFUND_FAILED',
        header: REFUND_FAILED,
        refund: { status: FAILED, failureReason: 'insufficient_funds' },
        owed: true,
        reason: 'insufficient_funds',
      });
    },
  );

  it('never takes a refusal for the late failure of a refund that succeeded', () => {
    const refusal = reported('failed', { refundId: null, failureReason: 'amount_too_large' });

    expect(settleRefund(REFUNDED, row(SUCCEEDED), refusal)).toEqual({ outcome: 'REFUNDED', owed: false });
  });

  it.each(['succeeded', 'pending', 'requires_action'] as const)(
    'ignores a %s report on a refund already settled as succeeded',
    (status) => {
      expect(settleRefund(REFUNDED, row(SUCCEEDED), reported(status))).toEqual({ outcome: 'REFUNDED', owed: false });
    },
  );

  it.each(['failed', 'canceled'] as const)(
    'moves a succeeded refund that %s later to REFUND_FAILED, owing the money once',
    (status) => {
      expect(settleRefund(REFUNDED, row(SUCCEEDED), reported(status))).toMatchObject({
        outcome: 'REFUND_FAILED',
        header: REFUND_FAILED,
        refund: { status: FAILED },
        owed: true,
      });
    },
  );

  it.each(['succeeded', 'pending', 'failed', 'canceled'] as const)(
    'changes nothing on a failed refund reported %s, and owes nothing again',
    (status) => {
      expect(settleRefund(REFUND_FAILED, row(FAILED), reported(status))).toEqual({
        outcome: 'REFUND_FAILED',
        owed: false,
        reason: 'expired_or_canceled_card',
      });
    },
  );

  it('leaves the row alone when the report is about another refund of the same charge', () => {
    expect(settleRefund(REFUNDING, row(PENDING, 're_1'), reported('failed', { refundId: 're_2' }))).toEqual({
      outcome: 'PENDING',
      owed: false,
    });
    expect(settleRefund(REFUNDED, row(SUCCEEDED, 're_1'), reported('failed', { refundId: 're_2' }))).toEqual({
      outcome: 'REFUNDED',
      owed: false,
    });
  });

  it.each([PaymentOrderStatus.CAPTURED, PaymentOrderStatus.OPEN, PaymentOrderStatus.CANCELLED])(
    'refuses to settle under a %s header, which never carries a refund row',
    (header) => {
      expect(() => settleRefund(header, row(PENDING), reported('succeeded'))).toThrow(/refund row under a/);
    },
  );
});
