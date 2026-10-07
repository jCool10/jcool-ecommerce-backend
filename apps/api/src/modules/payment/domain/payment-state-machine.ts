import { DomainError } from '@jcool/kernel';
import { PaymentStatus } from './payment-status';

// Terminal states (SUCCEEDED / FAILED / EXPIRED / VOIDED) have no outgoing edge, so a late or conflicting
// webhook onto an already-terminal payment is rejected here rather than left to the DB.

interface Transition {
  from: PaymentStatus;
  to: PaymentStatus;
  /**
   * Declared edges default to wired; a future refund/chargeback edge lands here as a flag flip,
   * not a restructure. false = declared but rejected at runtime.
   */
  wired: boolean;
}

const TRANSITIONS: readonly Transition[] = [
  { from: PaymentStatus.PENDING, to: PaymentStatus.SUCCEEDED, wired: true },
  { from: PaymentStatus.PENDING, to: PaymentStatus.FAILED, wired: true },
  { from: PaymentStatus.PENDING, to: PaymentStatus.EXPIRED, wired: true },
  { from: PaymentStatus.PENDING, to: PaymentStatus.AUTHORIZED, wired: true },
  // Voided straight from PENDING when the buyer authorized but no webhook recorded it yet.
  { from: PaymentStatus.PENDING, to: PaymentStatus.VOIDED, wired: true },
  { from: PaymentStatus.AUTHORIZED, to: PaymentStatus.SUCCEEDED, wired: true },
  { from: PaymentStatus.AUTHORIZED, to: PaymentStatus.VOIDED, wired: true },
  // The authorization lapsed or was cancelled at the gateway before capture.
  { from: PaymentStatus.AUTHORIZED, to: PaymentStatus.FAILED, wired: true },
];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.wired);
}

export class PaymentTransitionError extends DomainError {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Illegal payment transition: ${from} -> ${to}`);
    this.name = 'PaymentTransitionError';
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new PaymentTransitionError(from, to);
  }
}
