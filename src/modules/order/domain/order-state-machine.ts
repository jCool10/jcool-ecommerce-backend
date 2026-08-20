import { DomainError } from '@shared/kernel';
import { OrderStatus } from './order-status';

/**
 * Order state machine — a pure function over (from, to). It is the single source
 * of truth for which status changes are legal; every transition in the app goes
 * through `assertTransition`, so the rule lives in exactly one place (no if/else
 * scattered across use-cases).
 *
 * Only wired transitions are legal. The rest are declared (documented) but NOT
 * wired — attempting one is rejected at runtime — so a new capability is enabled
 * by flipping a flag here, never by restructuring. See docs/engineering-notes.md (Order).
 */

/** A single edge in the machine. */
interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** false = declared but not yet enabled; rejected at runtime until wired. */
  wired: boolean;
}

// The complete transition table. Only wired edges are legal; unwired ones are
// declared for a later week and rejected at runtime until flipped.
const TRANSITIONS: readonly Transition[] = [
  { from: OrderStatus.DRAFT, to: OrderStatus.PENDING, wired: true }, // place order (seam: reserve/idempotency/outbox)
  { from: OrderStatus.DRAFT, to: OrderStatus.CANCELLED, wired: true }, // discard a draft
  { from: OrderStatus.PENDING, to: OrderStatus.PAID, wired: true }, // finalize: payment webhook success / reconcile paid
  { from: OrderStatus.PENDING, to: OrderStatus.FAILED, wired: true }, // finalize: payment webhook failure / reconcile failed
  { from: OrderStatus.PENDING, to: OrderStatus.EXPIRED, wired: true }, // finalize: expiry sweep on an unpaid hold
  { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED, wired: false }, // later (user/admin cancel)
];

// Statuses a finalized/discarded order can never leave — the guard that turns an
// at-least-once webhook into an exactly-once effect: re-applying the same outcome
// is a no-op, and a conflicting one is ignored (never a regress), never applied.
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
]);

/** True only for a transition that is both declared AND wired for the current week. */
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
