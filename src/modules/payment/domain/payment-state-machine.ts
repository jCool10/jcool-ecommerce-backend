import { DomainError } from '@shared/kernel';
import { PaymentStatus } from './payment-status';

/**
 * Payment state machine — a pure function over (from, to), the single source of truth
 * for which payment status changes are legal. Every transition goes through
 * `assertTransition`, so the rule lives in one place (no scattered if/else).
 *
 * Terminal states (SUCCEEDED / FAILED / EXPIRED) have no outgoing edge: a late or
 * conflicting webhook onto an already-terminal payment is rejected here; deeper conflict handling
 * (refund, chargeback) is a flag flip away, not a restructure.
 */

interface Transition {
  from: PaymentStatus;
  to: PaymentStatus;
  /** false = declared but rejected at runtime. */
  wired: boolean;
}

const TRANSITIONS: readonly Transition[] = [
  { from: PaymentStatus.PENDING, to: PaymentStatus.SUCCEEDED, wired: true }, // webhook success
  { from: PaymentStatus.PENDING, to: PaymentStatus.FAILED, wired: true }, // webhook failure
  { from: PaymentStatus.PENDING, to: PaymentStatus.EXPIRED, wired: true }, // reconciliation: session lapsed unpaid
];

/** True only for a transition that is both declared AND wired. Pure — no I/O. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.wired);
}

/** Raised when a payment status change is illegal (undeclared) or declared-but-unwired. */
export class PaymentTransitionError extends DomainError {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Illegal payment transition: ${from} -> ${to}`);
    this.name = 'PaymentTransitionError';
  }
}

/** Throws `PaymentTransitionError` unless the transition is allowed. Pure — no I/O. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new PaymentTransitionError(from, to);
  }
}
