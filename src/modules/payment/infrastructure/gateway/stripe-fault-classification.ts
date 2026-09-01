import Stripe from 'stripe';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

/**
 * Whether a failed call is evidence about Stripe's health, or only about the request we sent it.
 *
 * A 4xx is Stripe answering — a rejected amount, a stale handle, a key we got wrong — and answering
 * means the service is up. Counted against the breaker, a run of unpayable orders would open the
 * circuit on a working gateway and take checkout down for everyone else. 429 is the exception: it is
 * Stripe asking us to send less, which is what an open circuit does. A transport failure carries no
 * status at all and is the plainest outage signal there is.
 */
export function isStripeUnavailable(error: unknown): boolean {
  const cause = error instanceof PaymentGatewayError ? error.cause : error;
  if (!(cause instanceof Stripe.errors.StripeError)) {
    return true;
  }
  const status = cause.statusCode;
  return status === undefined || status === 429 || status >= 500;
}
