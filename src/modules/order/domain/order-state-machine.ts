import { DomainError } from '@shared/kernel';
import { OrderStatus } from './order-status';

/**
 * The single source of truth for which status changes are legal — every transition goes through
 * `assertTransition`, so no use case carries its own if/else.
 *
 * Every edge is currently wired. The `wired` flag stays because it is the cheap way to land a
 * transition ahead of the code that drives it: declaring an edge documents the intended shape while
 * still rejecting it at runtime, so enabling it later is a flag flip rather than a restructure.
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

/** True only for an edge that is both declared AND wired. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.wired);
}

/** True for a settled order (no outgoing transition) — the finalize idempotency guard reads this. */
export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Raised when a status change is illegal (undeclared) or declared-but-not-yet-wired. */
export class OrderTransitionError extends DomainError {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = 'OrderTransitionError';
  }
}

/** Throws `OrderTransitionError` unless the transition is allowed. Pure — no I/O. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new OrderTransitionError(from, to);
  }
}
