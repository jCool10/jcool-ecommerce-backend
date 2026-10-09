import { DomainError } from '@jcool/kernel';
import { OrderStatus } from './order-status';

/**
 * Every status change goes through `assertTransition`, so no use case carries its own if/else.
 * Every edge is currently wired; the `wired` flag stays so a future transition can be declared
 * ahead of the code that drives it and still be rejected at runtime until it is flipped.
 */

interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  wired: boolean;
}

const TRANSITIONS: readonly Transition[] = [
  { from: OrderStatus.DRAFT, to: OrderStatus.RESERVING, wired: true }, // checkout: stock Try about to go out
  { from: OrderStatus.RESERVING, to: OrderStatus.PENDING, wired: true }, // Try held the stock
  { from: OrderStatus.RESERVING, to: OrderStatus.REJECTED, wired: true }, // Try refused, timed out, or was abandoned
  { from: OrderStatus.PENDING, to: OrderStatus.CONFIRMING, wired: true }, // authorization matched the total
  { from: OrderStatus.PENDING, to: OrderStatus.FAILED, wired: true }, // authorization did not match the total
  { from: OrderStatus.PENDING, to: OrderStatus.EXPIRED, wired: true }, // deadline and grace passed unpaid
  { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED, wired: true }, // user/admin cancel
  { from: OrderStatus.CONFIRMING, to: OrderStatus.PAID, wired: true }, // captured
  { from: OrderStatus.CONFIRMING, to: OrderStatus.FAILED, wired: true }, // commit refused, or not capturable
];

// The guard that turns an at-least-once event into an exactly-once effect: nothing leaves these.
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
]);

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.wired);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class OrderTransitionError extends DomainError {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = 'OrderTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new OrderTransitionError(from, to);
  }
}
