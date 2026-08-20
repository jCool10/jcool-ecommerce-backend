import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';

// Sign webhook fixtures for e2e exactly as the gateway signs in production: HMAC over the SAME raw
// bytes the test then POSTs, using the shared `signStripeStyle`. A real signature over a real body,
// not a self-mock — the server verifies it with the identical scheme. The returned `rawBody` MUST be
// sent verbatim so `req.rawBody` matches what was signed.

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export interface SignedWebhook {
  rawBody: string;
  headers: Record<string, string>;
}

export interface SignWebhookOptions {
  secret: string;
  event: Record<string, unknown>;
  /** Unix seconds stamped into (and signed with) the payload. Defaults to now; pass an old value to force expiry. */
  timestampSec?: number;
}

export function signWebhook({ secret, event, timestampSec }: SignWebhookOptions): SignedWebhook {
  const rawBody = JSON.stringify(event);
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  return {
    rawBody,
    headers: {
      [STRIPE_SIGNATURE_HEADER]: signStripeStyle(secret, ts, rawBody),
      'content-type': 'application/json',
    },
  };
}

/** Checkout Session success event → drives Payment PENDING→SUCCEEDED. `paymentIntent` links session→intent. */
export function checkoutSessionCompleted(
  sessionId: string,
  opts: { eventId?: string; paymentIntent?: string } = {},
): Record<string, unknown> {
  return {
    id: opts.eventId ?? 'evt_test_completed',
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, payment_intent: opts.paymentIntent } },
  };
}

/** Checkout Session expiry event → drives Payment PENDING→FAILED. */
export function checkoutSessionExpired(sessionId: string, opts: { eventId?: string } = {}): Record<string, unknown> {
  return {
    id: opts.eventId ?? 'evt_test_expired',
    type: 'checkout.session.expired',
    data: { object: { id: sessionId } },
  };
}
