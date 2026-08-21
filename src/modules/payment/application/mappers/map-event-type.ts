import { PaymentStatus } from '../../domain/payment-status';

/**
 * Map a gateway event type to the payment outcome it drives, for the coded Checkout Session flow.
 * Only the two session events are handled: the gateway adapter creates a Checkout Session (a `cs_`
 * handle), so those are the only events whose `data.object.id` matches a persisted payment. The
 * PaymentIntent flow (`payment_intent.*`) is intentionally absent — a `pi_` object id never matches
 * a session handle, so it could only be resolved via `metadata.order_id`; adopting it is a later
 * change, not dead code that silently never settles. Anything unmapped returns null: still logged
 * for audit, no payment change applied.
 */

const SUCCEEDED_EVENTS = new Set(['checkout.session.completed']);
const FAILED_EVENTS = new Set(['checkout.session.expired']);

/** The payment target for a webhook type, or null when the event carries no outcome we act on. */
export function mapEventType(type: string): PaymentStatus | null {
  if (SUCCEEDED_EVENTS.has(type)) return PaymentStatus.SUCCEEDED;
  if (FAILED_EVENTS.has(type)) return PaymentStatus.FAILED;
  return null;
}
