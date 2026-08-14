import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderStatus } from './order-status';
import { assertTransition, canTransition, OrderTransitionError } from './order-state-machine';

// The transitions wired for Week 3 — the single expectation the exhaustive test
// checks every (from, to) pair against. Future transitions are declared in the
// machine but not wired, so they must read as NOT allowed here.
const WIRED_TRANSITIONS: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  [OrderStatus.DRAFT, OrderStatus.PENDING],
  [OrderStatus.DRAFT, OrderStatus.CANCELLED],
];

function isWired(from: OrderStatus, to: OrderStatus): boolean {
  return WIRED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('order state machine', () => {
  it('allows the wired Week-3 transitions', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING)).toBe(true);
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.CANCELLED)).toBe(true);
  });

  it('blocks declared-but-unwired future transitions (notWiredYet)', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.FAILED)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.EXPIRED)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(false);
  });

  it('rejects reverse and otherwise-illegal transitions', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.DRAFT)).toBe(false);
    expect(canTransition(OrderStatus.PAID, OrderStatus.PENDING)).toBe(false);
    expect(canTransition(OrderStatus.CANCELLED, OrderStatus.DRAFT)).toBe(false);
  });

  it('is exhaustive: across every (from, to) pair, only the wired ones are allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(isWired(from, to));
      }
    }
  });

  describe('assertTransition', () => {
    it('passes for a wired transition', () => {
      expect(() => assertTransition(OrderStatus.DRAFT, OrderStatus.PENDING)).not.toThrow();
    });

    it('throws OrderTransitionError for an illegal transition', () => {
      expect(() => assertTransition(OrderStatus.PENDING, OrderStatus.DRAFT)).toThrow(OrderTransitionError);
    });

    it('throws for a declared-but-unwired transition', () => {
      expect(() => assertTransition(OrderStatus.PENDING, OrderStatus.PAID)).toThrow(OrderTransitionError);
    });

    it('carries the from/to on the error', () => {
      try {
        assertTransition(OrderStatus.PENDING, OrderStatus.PAID);
        expect.unreachable('assertTransition should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(OrderTransitionError);
        expect((error as OrderTransitionError).from).toBe(OrderStatus.PENDING);
        expect((error as OrderTransitionError).to).toBe(OrderStatus.PAID);
      }
    });
  });
});
