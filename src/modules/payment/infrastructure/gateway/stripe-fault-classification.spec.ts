import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';
import { isStripeUnavailable } from './stripe-fault-classification';

const stripeError = (type: string, statusCode: number): Stripe.errors.StripeError =>
  Stripe.errors.StripeError.generate({ type, statusCode, message: `${type} ${statusCode}` } as never);

// The adapter wraps everything it raises, so this is the shape the breaker actually classifies.
const wrapped = (cause: unknown): PaymentGatewayError => new PaymentGatewayError('Stripe call failed', cause);

describe('isStripeUnavailable', () => {
  it.each([
    ['a rejected request', 'invalid_request_error', 400],
    ['a declined card', 'card_error', 402],
    ['a key we got wrong', 'authentication_error', 401],
    ['a handle Stripe never issued', 'invalid_request_error', 404],
  ])('does not blame the gateway for %s', (_case, type, status) => {
    expect(isStripeUnavailable(wrapped(stripeError(type, status)))).toBe(false);
  });

  it.each([
    ['a server fault', 'api_error', 503],
    ['a gateway timeout', 'api_error', 504],
  ])('blames the gateway for %s', (_case, type, status) => {
    expect(isStripeUnavailable(wrapped(stripeError(type, status)))).toBe(true);
  });

  it('blames the gateway for a rate limit, because sending less is what an open circuit does', () => {
    expect(isStripeUnavailable(wrapped(stripeError('rate_limit_error', 429)))).toBe(true);
  });

  it('blames the gateway when the call never reached it', () => {
    // No status at all: the request died in transport, which is the plainest outage signal there is.
    expect(isStripeUnavailable(wrapped(new Stripe.errors.StripeConnectionError({ message: 'ECONNRESET' })))).toBe(true);
  });

  it('blames the gateway for anything it cannot recognise', () => {
    // A fault we cannot read is not evidence of health; the safe default is to count it.
    expect(isStripeUnavailable(wrapped(new Error('boom')))).toBe(true);
    expect(isStripeUnavailable(new Error('boom'))).toBe(true);
  });
});
