import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderStatus } from './order-status';
import { assertTransition, canTransition, isTerminal, OrderTransitionError } from './order-state-machine';

const WIRED_TRANSITIONS: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  [OrderStatus.DRAFT, OrderStatus.RESERVING],
  [OrderStatus.RESERVING, OrderStatus.PENDING],
  [OrderStatus.RESERVING, OrderStatus.REJECTED],
  [OrderStatus.PENDING, OrderStatus.CONFIRMING],
  [OrderStatus.PENDING, OrderStatus.FAILED],
  [OrderStatus.PENDING, OrderStatus.EXPIRED],
  [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMING, OrderStatus.PAID],
  [OrderStatus.CONFIRMING, OrderStatus.FAILED],
];

function isWired(from: OrderStatus, to: OrderStatus): boolean {
  return WIRED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('order state machine', () => {
  it('is exhaustive: across every (from, to) pair, only the wired ones are allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(isWired(from, to));
      }
    }
  });

  it('keeps the statuses appended after CANCELLED, matching the order of the pg enum', () => {
    expect(ORDER_STATUSES).toEqual([
      'DRAFT',
      'PENDING',
      'PAID',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
      'RESERVING',
      'REJECTED',
      'CONFIRMING',
    ]);
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

  it.each([
    [OrderStatus.PENDING, OrderStatus.PAID],
    [OrderStatus.CONFIRMING, OrderStatus.CANCELLED],
    [OrderStatus.REJECTED, OrderStatus.PENDING],
    [OrderStatus.DRAFT, OrderStatus.PENDING],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
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
