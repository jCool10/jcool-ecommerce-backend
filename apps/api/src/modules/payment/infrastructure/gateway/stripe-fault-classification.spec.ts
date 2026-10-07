import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentGatewayError, type IntentStatus } from '../../application/ports/payment-gateway.port';
import {
  captureOutcomeAfterFault,
  isServerError,
  isSessionNotOpen,
  isStripeUnavailable,
  isUnexpectedIntentState,
  voidOutcomeAfterFault,
} from './stripe-fault-classification';

const stripeError = (type: string, statusCode: number, code?: string): Stripe.errors.StripeError =>
  Stripe.errors.StripeError.generate({ type, statusCode, code, message: `${type} ${statusCode}` } as never);

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

// The two faults after which a capture or void reads the intent back. Everything else on those calls
// is an unknown outcome: a 409 means the same key is still in flight, not that the hold is gone.
describe('faults that send capture and void to read the intent back', () => {
  const unexpectedState = stripeError('invalid_request_error', 400, 'payment_intent_unexpected_state');

  it('recognises a 5xx, and nothing that might still be in flight', () => {
    const faults = [
      stripeError('api_error', 500),
      stripeError('api_error', 503),
      stripeError('idempotency_error', 409),
      stripeError('rate_limit_error', 429),
      unexpectedState,
      transportFailure(),
      new Error('boom'),
    ];

    expect(faults.map(isServerError)).toEqual([true, true, false, false, false, false, false]);
  });

  it('recognises an intent in the wrong state by its code, not by a bare 400', () => {
    const faults = [
      unexpectedState,
      wrapped(unexpectedState),
      stripeError('invalid_request_error', 400),
      stripeError('idempotency_error', 409),
      stripeError('api_error', 500),
    ];

    expect(faults.map(isUnexpectedIntentState)).toEqual([true, true, false, false, false]);
  });
});

describe('outcome of a faulted call, read off the intent', () => {
  const fault = stripeError('api_error', 500);
  const settle = <T>(read: (status: IntentStatus) => T, status: IntentStatus): T | PaymentGatewayError => {
    try {
      return read(status);
    } catch (error) {
      return error as PaymentGatewayError;
    }
  };

  it('reports a capture as done or as dead only on a state that proves it', () => {
    const read = (status: IntentStatus) => captureOutcomeAfterFault(status, fault);

    expect(settle(read, 'succeeded')).toEqual({ kind: 'captured' });
    expect(settle(read, 'canceled')).toEqual({ kind: 'not_capturable', intentStatus: 'canceled' });
    expect(settle(read, 'requires_payment_method')).toEqual({
      kind: 'not_capturable',
      intentStatus: 'requires_payment_method',
    });
  });

  it('reports a void as done whichever way the hold ended', () => {
    const read = (status: IntentStatus) => voidOutcomeAfterFault(status, fault);

    expect(['canceled', 'requires_payment_method', 'succeeded'].map((s) => settle(read, s as IntentStatus))).toEqual([
      'already_canceled',
      'already_canceled',
      'already_captured',
    ]);
  });

  // The key's stored failure would replay forever, so only a fresh key can reach the hold again.
  it('asks for a fresh key while the hold is still capturable', () => {
    for (const read of [captureOutcomeAfterFault, voidOutcomeAfterFault]) {
      const error = settle((status) => read(status, fault), 'requires_capture');

      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).retryWithFreshKey).toBe(true);
      expect((error as PaymentGatewayError).cause).toBe(fault);
    }
  });

  it('throws an unknown outcome, keeping the key, for an intent still moving', () => {
    for (const read of [captureOutcomeAfterFault, voidOutcomeAfterFault]) {
      for (const status of ['processing', 'other'] as const) {
        const error = settle((s) => read(s, fault), status);

        expect(error).toBeInstanceOf(PaymentGatewayError);
        expect((error as PaymentGatewayError).retryWithFreshKey).toBe(false);
      }
    }
  });
});
