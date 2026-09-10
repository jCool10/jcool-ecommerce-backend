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
  it('allows the wired transitions', () => {
    expect(canTransition(PaymentStatus.PENDING, PaymentStatus.SUCCEEDED)).toBe(true);
    expect(canTransition(PaymentStatus.PENDING, PaymentStatus.FAILED)).toBe(true);
    expect(canTransition(PaymentStatus.PENDING, PaymentStatus.EXPIRED)).toBe(true);
  });

  it('rejects every transition out of a terminal state', () => {
    for (const terminal of [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.EXPIRED]) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('is exhaustive: across every (from, to) pair, only the wired ones are allowed', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(from, to)).toBe(isWired(from, to));
      }
    }
  });

  describe('assertTransition', () => {
    it('passes for a wired transition', () => {
      expect(() => assertTransition(PaymentStatus.PENDING, PaymentStatus.SUCCEEDED)).not.toThrow();
    });

    it('throws PaymentTransitionError for an illegal transition', () => {
      expect(() => assertTransition(PaymentStatus.SUCCEEDED, PaymentStatus.FAILED)).toThrow(PaymentTransitionError);
    });

    it('throws when re-expiring an already-expired payment', () => {
      expect(() => assertTransition(PaymentStatus.EXPIRED, PaymentStatus.EXPIRED)).toThrow(PaymentTransitionError);
    });

    it('carries the from/to on the error', () => {
      try {
        assertTransition(PaymentStatus.SUCCEEDED, PaymentStatus.FAILED);
        expect.unreachable('assertTransition should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PaymentTransitionError);
        expect((error as PaymentTransitionError).from).toBe(PaymentStatus.SUCCEEDED);
        expect((error as PaymentTransitionError).to).toBe(PaymentStatus.FAILED);
      }
    });
  });
});
