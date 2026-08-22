import type { FinalizeOutcome } from '@modules/order/application/use-cases';
import { PaymentStatus } from '../../domain/payment-status';

/**
 * A pure function at the Payment↔Order boundary, so Payment names only Order's published
 * `FinalizeOutcome` and never its enum. EXPIRED maps to null because an expired session arrives as
 * PaymentStatus.FAILED (see mapEventType) — order EXPIRED is the sweep's outcome, never a webhook's.
 */
export function mapPaymentToOrderOutcome(status: PaymentStatus): FinalizeOutcome | null {
  if (status === PaymentStatus.SUCCEEDED) return 'PAID';
  if (status === PaymentStatus.FAILED) return 'FAILED';
  return null;
}
