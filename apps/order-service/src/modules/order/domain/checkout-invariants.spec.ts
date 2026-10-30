import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_INVARIANT_KINDS,
  TERMINAL_SAGA_STATUSES,
  evaluateCheckoutInvariants,
  type PaymentStanding,
  type StockStanding,
} from './checkout-invariants';
import { OrderStatus } from './order-status';

const payment = (overrides: Partial<PaymentStanding> = {}): PaymentStanding => ({
  header: null,
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
  ...overrides,
});

const CAPTURED = payment({ header: 'CAPTURED', authorizedPaymentId: 'pay-1', hasSucceededAttempt: true });
const CANCELLED = payment({ header: 'CANCELLED' });

const evaluate = (status: OrderStatus, stock: StockStanding, standing: PaymentStanding = payment()) =>
  evaluateCheckoutInvariants({ status, stock, payment: standing });

describe('evaluateCheckoutInvariants', () => {
  it('passes a paid order whose stock is committed and whose money is captured', () => {
    expect(evaluate(OrderStatus.PAID, 'COMMITTED', CAPTURED)).toEqual([]);
  });

  it.each([
    [OrderStatus.EXPIRED, 'RELEASED'],
    [OrderStatus.CANCELLED, 'RELEASED'],
    [OrderStatus.FAILED, 'RESTOCKED'],
    [OrderStatus.REJECTED, 'FENCED'],
  ] as const)('passes a %s order whose stock is %s and whose payment is closed', (status, stock) => {
    expect(evaluate(status, stock, CANCELLED)).toEqual([]);
  });

  it('passes an order rejected before either participant heard of it', () => {
    expect(evaluate(OrderStatus.REJECTED, null)).toEqual([]);
  });

  describe('captured_without_paid', () => {
    it('flags a captured header on an order that is not paid', () => {
      expect(evaluate(OrderStatus.EXPIRED, 'RELEASED', CAPTURED)).toEqual(['captured_without_paid']);
    });

    it('flags a succeeded attempt even under a header that was cancelled', () => {
      expect(
        evaluate(OrderStatus.EXPIRED, 'RELEASED', payment({ header: 'CANCELLED', hasSucceededAttempt: true })),
      ).toEqual(['captured_without_paid']);
    });
  });

  describe('paid_without_capture', () => {
    it.each(['AUTHORIZED', 'CANCELLED', null] as const)('flags a paid order whose header is %s', (header) => {
      expect(evaluate(OrderStatus.PAID, 'COMMITTED', payment({ header }))).toEqual(['paid_without_capture']);
    });
  });

  describe('paid_without_commit', () => {
    it.each(['HELD', 'RELEASED', null] as const)('flags a paid order whose stock is %s', (stock) => {
      expect(evaluate(OrderStatus.PAID, stock, CAPTURED)).toEqual(['paid_without_commit']);
    });
  });

  describe('orphan_hold', () => {
    it.each([OrderStatus.EXPIRED, OrderStatus.CANCELLED, OrderStatus.FAILED, OrderStatus.REJECTED])(
      'flags stock still held for a %s order',
      (status) => {
        expect(evaluate(status, 'HELD', CANCELLED)).toEqual(['orphan_hold']);
      },
    );

    it('is not raised for a held hold on a paid order, which is a missing commit instead', () => {
      expect(evaluate(OrderStatus.PAID, 'HELD', CAPTURED)).not.toContain('orphan_hold');
    });
  });

  describe('authorized_on_dead_order', () => {
    it('flags an authorized attempt left under a cancelled header', () => {
      expect(
        evaluate(OrderStatus.CANCELLED, 'RELEASED', payment({ header: 'CANCELLED', hasAuthorizedAttempt: true })),
      ).toEqual(['authorized_on_dead_order']);
    });

    it('is not raised on a paid order', () => {
      expect(evaluate(OrderStatus.PAID, 'COMMITTED', { ...CAPTURED, hasAuthorizedAttempt: true })).toEqual([]);
    });
  });

  it('reports every kind an order breaks', () => {
    const money = payment({ header: 'CAPTURED', hasAuthorizedAttempt: true, hasSucceededAttempt: true });

    expect(evaluate(OrderStatus.EXPIRED, 'HELD', money)).toEqual([
      'captured_without_paid',
      'orphan_hold',
      'authorized_on_dead_order',
    ]);
  });

  it('refuses an order the saga has not settled', () => {
    expect(() => evaluate(OrderStatus.PENDING, 'HELD')).toThrow(/PENDING/);
  });

  it('names its kinds and the statuses it checks', () => {
    expect(CHECKOUT_INVARIANT_KINDS).toEqual([
      'captured_without_paid',
      'paid_without_capture',
      'paid_without_commit',
      'orphan_hold',
      'authorized_on_dead_order',
    ]);
    expect(TERMINAL_SAGA_STATUSES).toEqual([
      OrderStatus.PAID,
      OrderStatus.FAILED,
      OrderStatus.EXPIRED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
    ]);
  });
});
