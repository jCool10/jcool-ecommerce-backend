import { PaymentOrderStatus } from './payment-order-status';
import { PaymentStatus } from './payment-status';

export type AuthorizationDecision = 'RECORD' | 'RECORD_LATE' | 'ALREADY_RECORDED' | 'STRAY' | 'AMOUNT_MISMATCH';

export interface AuthorizationFacts {
  payment: { status: PaymentStatus; amountMinor: number; currency: string };
  header: {
    status: PaymentOrderStatus;
    amountMinor: number | null;
    currency: string | null;
    authorizedAt: Date | null;
  };
  /** What Stripe holds on the card. */
  charge: { amountMinor?: number; currency?: string };
}

const RECORDED = new Set<PaymentStatus>([PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED, PaymentStatus.VOIDED]);
const RETIRED = new Set<PaymentStatus>([PaymentStatus.EXPIRED, PaymentStatus.FAILED]);
const HEADER_HOLDS = new Set<PaymentOrderStatus>([PaymentOrderStatus.AUTHORIZED, PaymentOrderStatus.CAPTURED]);

/**
 * What to do with a hold Stripe reports on a payment. Checked in order: a hold that is not the
 * order's current attempt, or that comes after the order already recorded one, is stray and gets
 * voided, so an order never emits `payment.authorized` twice.
 */
export function decideAuthorization({ payment, header, charge }: AuthorizationFacts): AuthorizationDecision {
  if (RECORDED.has(payment.status)) return 'ALREADY_RECORDED';
  if (RETIRED.has(payment.status) || header.authorizedAt !== null || HEADER_HOLDS.has(header.status)) {
    return 'STRAY';
  }
  if (!chargeMatches(header, charge) || !chargeMatches(payment, charge)) return 'AMOUNT_MISMATCH';
  return header.status === PaymentOrderStatus.CANCELLED ? 'RECORD_LATE' : 'RECORD';
}

function chargeMatches(
  expected: { amountMinor: number | null; currency: string | null },
  charge: AuthorizationFacts['charge'],
): boolean {
  return (
    expected.amountMinor !== null &&
    expected.currency !== null &&
    charge.amountMinor === expected.amountMinor &&
    charge.currency?.toUpperCase() === expected.currency.toUpperCase()
  );
}
