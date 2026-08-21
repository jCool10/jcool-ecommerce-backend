import type { FinalizeOutcome } from '@modules/order/application/use-cases';
import { PaymentStatus } from '../../domain/payment-status';

/**
 * Translate a settled payment status into the Order finalization outcome it drives, at the
 * Payment↔Order boundary. Kept a pure function (not a domain import) so Payment names only Order's
 * published `FinalizeOutcome` type, never its enum. A settled SUCCEEDED pays the order; a settled
 * FAILED fails it. PENDING has no outcome (nothing to finalize), and an expired *session* comes in
 * as PaymentStatus.FAILED (see mapEventType) — the order EXPIRED state is the reconciliation cron's
 * job, not a webhook's, so EXPIRED maps to null here.
 */
export function mapPaymentToOrderOutcome(status: PaymentStatus): FinalizeOutcome | null {
  if (status === PaymentStatus.SUCCEEDED) return 'PAID';
  if (status === PaymentStatus.FAILED) return 'FAILED';
  return null;
}
