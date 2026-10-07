import Stripe from 'stripe';
import {
  PaymentGatewayError,
  type CaptureResult,
  type IntentStatus,
  type VoidOutcome,
} from '../../application/ports/payment-gateway.port';

function unwrap(error: unknown): unknown {
  return error instanceof PaymentGatewayError ? error.cause : error;
}

/**
 * A 4xx is Stripe answering — a rejected amount, a stale handle, a key we got wrong — and answering
 * means the service is up. Counted against the breaker, a run of unpayable orders would open the
 * circuit on a working gateway and take checkout down for everyone else. 429 is the exception: it is
 * Stripe asking us to send less, which is what an open circuit does. A transport failure carries no
 * status at all and is the plainest outage signal there is — hence the default.
 */
export function isStripeUnavailable(error: unknown): boolean {
  const cause = unwrap(error);
  if (!(cause instanceof Stripe.errors.StripeError)) {
    return true;
  }
  const status = cause.statusCode;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * Matched on status and error class only — Stripe publishes no error code for this refusal and commits
 * to no wording, and the expire call sends no body, so a 400 from it is a state refusal. It says the
 * session is not open; it does NOT say whether money moved — only reading it back tells those apart.
 */
export function isSessionNotOpen(error: unknown): boolean {
  const cause = unwrap(error);
  return cause instanceof Stripe.errors.StripeInvalidRequestError && cause.statusCode === 400;
}

export function isServerError(error: unknown): boolean {
  const cause = unwrap(error);
  return cause instanceof Stripe.errors.StripeError && cause.statusCode !== undefined && cause.statusCode >= 500;
}

export function isUnexpectedIntentState(error: unknown): boolean {
  const cause = unwrap(error);
  return cause instanceof Stripe.errors.StripeInvalidRequestError && cause.code === 'payment_intent_unexpected_state';
}

/**
 * After a 5xx or a state refusal the intent itself is the only record of what the call did. A hold
 * that is still capturable means the key now carries a stored failure, so it must be rotated.
 */
export function captureOutcomeAfterFault(status: IntentStatus, fault: unknown): CaptureResult {
  switch (status) {
    case 'succeeded':
      return { kind: 'captured' };
    case 'canceled':
    case 'requires_payment_method':
      return { kind: 'not_capturable', intentStatus: status };
    default:
      throw faultedOn('capture', status, fault);
  }
}

export function voidOutcomeAfterFault(status: IntentStatus, fault: unknown): VoidOutcome {
  switch (status) {
    case 'canceled':
    case 'requires_payment_method':
      return 'already_canceled';
    case 'succeeded':
      return 'already_captured';
    default:
      throw faultedOn('void', status, fault);
  }
}

function faultedOn(call: string, status: IntentStatus, fault: unknown): PaymentGatewayError {
  return new PaymentGatewayError(`Stripe ${call} failed with the intent still ${status}`, fault, {
    retryWithFreshKey: status === 'requires_capture',
  });
}
