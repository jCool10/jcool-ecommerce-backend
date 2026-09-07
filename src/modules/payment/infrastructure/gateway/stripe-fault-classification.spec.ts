import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';
import { isSessionNotOpen, isStripeUnavailable } from './stripe-fault-classification';

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

describe('isSessionNotOpen', () => {
  // Deliberately keyed on the error class and status alone, not on the message: Stripe's wording is
  // not a contract, and the caller resolves the ambiguity by reading the session back anyway.
  it('recognises the refusal Stripe gives for any session that is no longer open', () => {
    expect(isSessionNotOpen(wrapped(stripeError('invalid_request_error', 400)))).toBe(true);
    expect(isSessionNotOpen(stripeError('invalid_request_error', 400))).toBe(true);
  });

  it.each([
    ['a handle that was never issued', 'invalid_request_error', 404],
    ['a rate limit', 'rate_limit_error', 429],
    ['a server fault', 'api_error', 503],
    ['a key we got wrong', 'authentication_error', 401],
  ])('does not read %s as a refusal', (_case, type, status) => {
    expect(isSessionNotOpen(wrapped(stripeError(type, status)))).toBe(false);
  });

  it('does not read a transport failure or a plain error as a refusal', () => {
    expect(isSessionNotOpen(wrapped(new Stripe.errors.StripeConnectionError({ message: 'ECONNRESET' })))).toBe(false);
    expect(isSessionNotOpen(new Error('boom'))).toBe(false);
  });
});
