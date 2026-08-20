import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderStatus } from './order-status';
import { assertTransition, canTransition, isTerminal, OrderTransitionError } from './order-state-machine';

// Every wired edge — the single expectation the exhaustive test checks each (from, to)
// pair against. Declared-but-unwired transitions must read as NOT allowed here.
const WIRED_TRANSITIONS: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  [OrderStatus.DRAFT, OrderStatus.PENDING],
  [OrderStatus.DRAFT, OrderStatus.CANCELLED],
  [OrderStatus.PENDING, OrderStatus.PAID],
  [OrderStatus.PENDING, OrderStatus.FAILED],
  [OrderStatus.PENDING, OrderStatus.EXPIRED],
];

function isWired(from: OrderStatus, to: OrderStatus): boolean {
  return WIRED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('order state machine', () => {
  it('allows placing and discarding a draft', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING)).toBe(true);
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.CANCELLED)).toBe(true);
  });

  it('allows finalizing a PENDING order to each terminal outcome', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.PAID)).toBe(true);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.FAILED)).toBe(true);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.EXPIRED)).toBe(true);
  });

  it('blocks declared-but-unwired transitions', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(false);
  });

  it('never lets a terminal order transition (no regress off a finalized outcome)', () => {
    expect(canTransition(OrderStatus.PAID, OrderStatus.FAILED)).toBe(false);
    expect(canTransition(OrderStatus.PAID, OrderStatus.PENDING)).toBe(false);
    expect(canTransition(OrderStatus.FAILED, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.EXPIRED, OrderStatus.PAID)).toBe(false);
  });

  it('rejects reverse and otherwise-illegal transitions', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.DRAFT)).toBe(false);
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PAID)).toBe(false); // must be PENDING first
    expect(canTransition(OrderStatus.CANCELLED, OrderStatus.DRAFT)).toBe(false);
  });

  describe('isTerminal', () => {
    it('is true for settled states and false for in-flight ones', () => {
      expect(isTerminal(OrderStatus.PAID)).toBe(true);
      expect(isTerminal(OrderStatus.FAILED)).toBe(true);
      expect(isTerminal(OrderStatus.EXPIRED)).toBe(true);
      expect(isTerminal(OrderStatus.CANCELLED)).toBe(true);
      expect(isTerminal(OrderStatus.DRAFT)).toBe(false);
      expect(isTerminal(OrderStatus.PENDING)).toBe(false);
    });

    it('leaves no outgoing wired transition from any terminal status', () => {
      for (const from of ORDER_STATUSES) {
        if (!isTerminal(from)) continue;
        for (const to of ORDER_STATUSES) {
          expect(canTransition(from, to)).toBe(false);
        }
      }
    });
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
      expect(() => assertTransition(OrderStatus.PENDING, OrderStatus.CANCELLED)).toThrow(OrderTransitionError);
    });

    it('carries the from/to on the error', () => {
      try {
        assertTransition(OrderStatus.PENDING, OrderStatus.CANCELLED);
        expect.unreachable('assertTransition should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(OrderTransitionError);
        expect((error as OrderTransitionError).from).toBe(OrderStatus.PENDING);
        expect((error as OrderTransitionError).to).toBe(OrderStatus.CANCELLED);
      }
    });
  });
});
