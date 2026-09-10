import Stripe from 'stripe';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

/**
 * A 4xx is Stripe answering — a rejected amount, a stale handle, a key we got wrong — and answering
 * means the service is up. Counted against the breaker, a run of unpayable orders would open the
 * circuit on a working gateway and take checkout down for everyone else. 429 is the exception: it is
 * Stripe asking us to send less, which is what an open circuit does. A transport failure carries no
 * status at all and is the plainest outage signal there is — hence the default.
 */
export function isStripeUnavailable(error: unknown): boolean {
  const cause = error instanceof PaymentGatewayError ? error.cause : error;
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
  const cause = error instanceof PaymentGatewayError ? error.cause : error;
  return cause instanceof Stripe.errors.StripeInvalidRequestError && cause.statusCode === 400;
}
