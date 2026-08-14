import { DomainError } from '@shared/kernel';
import { OrderStatus } from './order-status';

/**
 * Order state machine — a pure function over (from, to). It is the single source
 * of truth for which status changes are legal; every transition in the app goes
 * through `assertTransition`, so the rule lives in exactly one place (no if/else
 * scattered across use-cases).
 *
 * Week 3 wires only the transitions the Order skeleton needs. The remaining
 * transitions are declared (documented) but NOT wired — attempting one is
 * rejected at runtime — so later weeks enable a boss fight by flipping a flag
 * here, never by restructuring. See docs/engineering-notes.md (Order).
 */

/** A single edge in the machine, with the week it gets wired. */
interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** false = declared for a later week; rejected at runtime until wired. */
  wired: boolean;
}

// The complete transition table. Wired edges are the only ones allowed in Week 3.
const TRANSITIONS: readonly Transition[] = [
  { from: OrderStatus.DRAFT, to: OrderStatus.PENDING, wired: true }, // place order (seam: reserve/idempotency/outbox)
  { from: OrderStatus.DRAFT, to: OrderStatus.CANCELLED, wired: true }, // discard a draft
  { from: OrderStatus.PENDING, to: OrderStatus.PAID, wired: false }, // T6-7 BF#3 (payment webhook success)
  { from: OrderStatus.PENDING, to: OrderStatus.FAILED, wired: false }, // T7/T9 BF#3/#4 (webhook failure → compensation)
  { from: OrderStatus.PENDING, to: OrderStatus.EXPIRED, wired: false }, // T9 BF#4 (reservation TTL → compensation)
  { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED, wired: false }, // later (user/admin cancel)
];

/** True only for a transition that is both declared AND wired for the current week. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.wired);
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
