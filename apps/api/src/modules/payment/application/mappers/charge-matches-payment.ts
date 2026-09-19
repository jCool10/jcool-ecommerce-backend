import type { Payment } from '../../domain/payment.entity';

/**
 * A divergence is never retryable: it means this session is not the one this payment was for — a
 * mislinked or reused handle, or a snapshot bug — so applying it would settle an order against the
 * wrong money. Absent fields count as a divergence; on the money path, no proof is not proof.
 *
 * One predicate for both money paths (webhook event and reconcile probe) on purpose: two copies
 * could drift, and the looser of the two would then be the one that settles an order.
 */
export function chargeMatchesPayment(payment: Payment, charge: { amountMinor?: number; currency?: string }): boolean {
  return (
    charge.amountMinor === payment.amountMinor &&
    charge.currency !== undefined &&
    // Gateways report ISO-4217 lowercase; `Payment.currency` is normalized upper at construction.
    charge.currency.toUpperCase() === payment.currency
  );
}
