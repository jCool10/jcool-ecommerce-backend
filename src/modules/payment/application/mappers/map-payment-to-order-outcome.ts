import type { FinalizeOutcome } from '@modules/order/application/public/order-finalization.port';
import { PaymentStatus } from '../../domain/payment-status';

/**
 * No status maps to EXPIRED: an expired session arrives as PaymentStatus.FAILED (see
 * mapEventToOutcome), and order EXPIRED is the sweep's outcome, never a webhook's.
 */
export function mapPaymentToOrderOutcome(status: PaymentStatus): FinalizeOutcome | null {
  if (status === PaymentStatus.SUCCEEDED) return 'PAID';
  if (status === PaymentStatus.FAILED) return 'FAILED';
  return null;
}
