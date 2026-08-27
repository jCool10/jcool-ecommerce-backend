import { PaymentStatus, type SettledPaymentStatus } from '../../domain/payment-status';

/**
 * Map a gateway event to the payment outcome it drives, for the coded Checkout Session flow.
 * Only the two session events are handled: the gateway adapter creates a Checkout Session (a `cs_`
 * handle), so those are the only events whose `data.object.id` matches a persisted payment. The
 * PaymentIntent flow (`payment_intent.*`) is intentionally absent — a `pi_` object id never matches
 * a session handle, so it could only be resolved via `metadata.order_id`; adopting it is a later
 * change, not dead code that silently never settles.
 *
 * `checkout.session.completed` means the session finished, NOT that the money cleared: an async
 * payment method completes the session while still `unpaid` and clears minutes to days later.
 * Settling on the event type alone would mark such an order PAID and hand over its stock for free,
 * so success is gated on `payment_status` — the same field the adapter's polling path already gates
 * on. An uncleared session stays PENDING until the reconciliation sweep polls it as paid.
 */

// A fully-discounted session captures nothing and is already final, so it settles like a paid one.
const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);

export type EventOutcome =
  | { kind: 'settle'; status: SettledPaymentStatus }
  // A session event we deliberately do not apply yet — the money has not cleared.
  | { kind: 'awaiting_payment' }
  // An event type we log for audit but never act on.
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
