import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';
import {
  isSessionNotOpen,
  isStripeServerError,
  isStripeUnavailable,
  isUnexpectedIntentState,
} from './stripe-fault-classification';

const stripeError = (type: string, statusCode: number): Stripe.errors.StripeError =>
  Stripe.errors.StripeError.generate({ type, statusCode, message: `${type} ${statusCode}` } as never);

// The adapter wraps everything it raises, so this is the shape the breaker actually classifies.
const wrapped = (cause: unknown): PaymentGatewayError => new PaymentGatewayError('Stripe call failed', cause);

const transportFailure = () => new Stripe.errors.StripeConnectionError({ message: 'ECONNRESET' });

// The breaker counts only these, so a bad API key or a declined card never opens it.
describe('isStripeUnavailable', () => {
  it('does not blame the gateway for a 4xx other than a rate limit', () => {
    const faults = [
      stripeError('invalid_request_error', 400),
      stripeError('card_error', 402),
      stripeError('authentication_error', 401),
      stripeError('invalid_request_error', 404),
    ];

    expect(faults.map((fault) => isStripeUnavailable(wrapped(fault)))).toEqual([false, false, false, false]);
  });

  // A rate limit is answered by sending less, which is what an open circuit does; a fault it cannot
  // read is not evidence of health.
  it('blames the gateway for a rate limit, a 5xx, a transport failure or anything unrecognised', () => {
    const faults = [
      wrapped(stripeError('rate_limit_error', 429)),
      wrapped(stripeError('api_error', 503)),
      wrapped(stripeError('api_error', 504)),
      wrapped(transportFailure()),
      wrapped(new Error('boom')),
      new Error('boom'),
    ];

    expect(faults.map(isStripeUnavailable)).toEqual([true, true, true, true, true, true]);
  });
});

describe('isSessionNotOpen', () => {
  // Keyed on the error class and status alone: Stripe's wording is not a contract, and the caller
  // resolves the ambiguity by reading the session back anyway.
  it('recognises the refusal Stripe gives for any session that is no longer open', () => {
    expect(isSessionNotOpen(wrapped(stripeError('invalid_request_error', 400)))).toBe(true);
    expect(isSessionNotOpen(stripeError('invalid_request_error', 400))).toBe(true);
  });

  it('does not read any other failure as a refusal', () => {
    const faults = [
      wrapped(stripeError('invalid_request_error', 404)),
      wrapped(stripeError('rate_limit_error', 429)),
      wrapped(stripeError('api_error', 503)),
      wrapped(stripeError('authentication_error', 401)),
      wrapped(transportFailure()),
      new Error('boom'),
    ];

    expect(faults.map(isSessionNotOpen)).toEqual([false, false, false, false, false, false]);
  });
});

// A 409 (same key in flight), a 429 and a timeout say nothing about whether the call landed.
describe('capture and void outcomes', () => {
  it('treats only a 5xx as an answer Stripe may have stored under the key', () => {
    const faults = [
      stripeError('api_error', 500),
      stripeError('api_error', 503),
      stripeError('idempotency_error', 409),
      stripeError('rate_limit_error', 429),
      stripeError('invalid_request_error', 400),
      transportFailure(),
    ];

    expect(faults.map(isStripeServerError)).toEqual([true, true, false, false, false, false]);
  });

  it('recognises a refusal because the intent already moved on', () => {
    const unexpected = Stripe.errors.StripeError.generate({
      type: 'invalid_request_error',
      statusCode: 400,
      code: 'payment_intent_unexpected_state',
      message: 'This PaymentIntent could not be captured because it has a status of canceled.',
    });

    expect(isUnexpectedIntentState(unexpected)).toBe(true);
    expect(isUnexpectedIntentState(stripeError('invalid_request_error', 400))).toBe(false);
  });
});
