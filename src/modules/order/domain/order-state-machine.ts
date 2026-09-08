import { DomainError } from '@shared/kernel';
import { OrderStatus } from './order-status';

/**
 * Every status change goes through `assertTransition`, so no use case carries its own if/else.
 * Every edge is currently wired; the `wired` flag stays so a future transition can be declared
 * ahead of the code that drives it and still be rejected at runtime until it is flipped.
 */

interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** false = declared but rejected at runtime. */
  wired: boolean;
}

const TRANSITIONS: readonly Transition[] = [
  { from: OrderStatus.DRAFT, to: OrderStatus.PENDING, wired: true }, // place order
  { from: OrderStatus.DRAFT, to: OrderStatus.CANCELLED, wired: true }, // discard a draft
  { from: OrderStatus.PENDING, to: OrderStatus.PAID, wired: true }, // finalize: payment webhook success / reconcile paid
  { from: OrderStatus.PENDING, to: OrderStatus.FAILED, wired: true }, // finalize: payment webhook failure / reconcile failed
  { from: OrderStatus.PENDING, to: OrderStatus.EXPIRED, wired: true }, // finalize: expiry sweep on an unpaid hold
  { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED, wired: true }, // finalize: user/admin cancel
];

// The guard that turns an at-least-once webhook into an exactly-once effect: nothing leaves these.
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
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
