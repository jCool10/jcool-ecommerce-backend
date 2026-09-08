import { PaymentStatus, type SettledPaymentStatus } from '../../domain/payment-status';

/**
 * `payment_intent.*` is intentionally absent: the adapter creates Checkout Sessions, so a `pi_` object
 * id never matches a persisted `cs_` handle and could only be resolved via `metadata.order_id`.
 * `checkout.session.completed` means the session finished, NOT that the money cleared — an async
 * method completes the session while still `unpaid` — so success is gated on `payment_status`.
 * Settling on the event type alone would mark such an order PAID and hand over its stock for free.
 */

// A fully-discounted session captures nothing and is already final, so it settles like a paid one.
const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);

export type EventOutcome =
  | { kind: 'settle'; status: SettledPaymentStatus }
  | { kind: 'awaiting_payment' }
  | { kind: 'ignore' };

export function mapEventToOutcome(type: string, paymentStatus?: string): EventOutcome {
  if (type === 'checkout.session.completed') {
    return paymentStatus !== undefined && SETTLED_PAYMENT_STATUSES.has(paymentStatus)
      ? { kind: 'settle', status: PaymentStatus.SUCCEEDED }
      : { kind: 'awaiting_payment' };
  }
  if (type === 'checkout.session.expired') {
    return { kind: 'settle', status: PaymentStatus.FAILED };
  }
  return { kind: 'ignore' };
}
