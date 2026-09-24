import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, PaymentStatus } from './payment-status';
import { assertTransition, canTransition, PaymentTransitionError } from './payment-state-machine';

const WIRED_TRANSITIONS: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
  [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED],
  [PaymentStatus.PENDING, PaymentStatus.FAILED],
  [PaymentStatus.PENDING, PaymentStatus.EXPIRED],
];

function isWired(from: PaymentStatus, to: PaymentStatus): boolean {
  return WIRED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('payment state machine', () => {
  it('is exhaustive: across every (from, to) pair, only the wired ones are allowed', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(from, to)).toBe(isWired(from, to));
      }
    }
  });

  it('rejects every transition out of a terminal state', () => {
    for (const terminal of [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.EXPIRED]) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('throws PaymentTransitionError carrying the from/to for an illegal transition', () => {
    let error: unknown;
    try {
      assertTransition(PaymentStatus.SUCCEEDED, PaymentStatus.FAILED);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(PaymentTransitionError);
    expect(error).toMatchObject({ from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED });
  });
});
