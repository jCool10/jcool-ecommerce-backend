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

/**
 * The charge a Checkout Session reports. `checkout.session.completed` only settles when the money
 * has cleared AND the amount matches the recorded payment, so fixtures state the charge explicitly:
 * pass the real payment's amount to settle, or a divergent one to exercise the refusal paths. A
 * `null` field means the gateway omitted it entirely, which is distinct from sending a wrong value.
 */
export interface SessionCharge {
  amountMinor: number | null;
  currency: string | null;
  /** `paid` | `no_payment_required` settle; `unpaid` (Stripe's async methods) must not. */
  paymentStatus?: string | null;
}

/** Checkout Session success event → drives Payment PENDING→SUCCEEDED. `paymentIntent` links session→intent. */
export function checkoutSessionCompleted(
  sessionId: string,
  charge: SessionCharge,
  opts: { eventId?: string; paymentIntent?: string } = {},
): Record<string, unknown> {
  const object: Record<string, unknown> = { id: sessionId, payment_intent: opts.paymentIntent };
  if (charge.paymentStatus !== null) object.payment_status = charge.paymentStatus ?? 'paid';
  if (charge.amountMinor !== null) object.amount_total = charge.amountMinor;
  if (charge.currency !== null) object.currency = charge.currency.toLowerCase();
  return {
    id: opts.eventId ?? 'evt_test_completed',
    type: 'checkout.session.completed',
    data: { object },
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
