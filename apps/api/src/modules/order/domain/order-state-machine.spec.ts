import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderStatus } from './order-status';
import { assertTransition, canTransition, isTerminal, OrderTransitionError } from './order-state-machine';

const WIRED_TRANSITIONS: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  [OrderStatus.DRAFT, OrderStatus.CANCELLED],
  [OrderStatus.PENDING, OrderStatus.EXPIRED],
  [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.DRAFT, OrderStatus.RESERVING],
  [OrderStatus.RESERVING, OrderStatus.PENDING],
  [OrderStatus.RESERVING, OrderStatus.REJECTED],
  [OrderStatus.PENDING, OrderStatus.CONFIRMING],
  [OrderStatus.CONFIRMING, OrderStatus.PAID],
  [OrderStatus.CONFIRMING, OrderStatus.FAILED],
];

function isWired(from: OrderStatus, to: OrderStatus): boolean {
  return WIRED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('order state machine', () => {
  // The pg enum is declared from this list, and ADD VALUE ... BEFORE keeps an existing database in step.
  it('declares the statuses in contract order', () => {
    expect(ORDER_STATUSES).toEqual([
      'DRAFT',
      'RESERVING',
      'PENDING',
      'CONFIRMING',
      'PAID',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
      'REJECTED',
    ]);
  });

  it('is exhaustive: across every (from, to) pair, only the wired ones are allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(isWired(from, to));
      }
    }
  });

  it('is true for settled states and false for in-flight ones', () => {
    expect(Object.fromEntries(ORDER_STATUSES.map((status) => [status, isTerminal(status)]))).toEqual({
      [OrderStatus.DRAFT]: false,
      [OrderStatus.RESERVING]: false,
      [OrderStatus.PENDING]: false,
      [OrderStatus.CONFIRMING]: false,
      [OrderStatus.PAID]: true,
      [OrderStatus.FAILED]: true,
      [OrderStatus.EXPIRED]: true,
      [OrderStatus.CANCELLED]: true,
      [OrderStatus.REJECTED]: true,
    });
  });

  // Its oracle is isTerminal, not the table above, so it catches an edge added to both in lockstep.
  it('leaves no outgoing wired transition from any terminal status', () => {
    for (const from of ORDER_STATUSES.filter(isTerminal)) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  // Payment is taken only through CONFIRMING, so nothing can mark an order PAID behind the saga's back.
  it('places only through RESERVING and settles payment only through CONFIRMING', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.FAILED)).toBe(false);
  });

  it('throws OrderTransitionError carrying the from/to for an illegal transition', () => {
    let error: unknown;
    try {
      assertTransition(OrderStatus.PAID, OrderStatus.CANCELLED);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(OrderTransitionError);
    expect(error).toMatchObject({ from: OrderStatus.PAID, to: OrderStatus.CANCELLED });
  });
});
