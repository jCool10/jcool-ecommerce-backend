import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';

// A real signature over a real body, not a self-mock: HMAC over the SAME raw bytes the test then
// POSTs, using the shared `signStripeStyle`. The returned `rawBody` MUST be sent verbatim, or
// `req.rawBody` will not match what was signed.

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export interface SignedWebhook {
  rawBody: string;
  headers: Record<string, string>;
}

export interface SignWebhookOptions {
  secret: string;
  event: Record<string, unknown>;
  /** Unix seconds stamped into (and signed with) the payload; pass an old value to force expiry. */
  timestampSec?: number;
}

export function signWebhook({ secret, event, timestampSec }: SignWebhookOptions): SignedWebhook {
  return signWebhookAs({ sign: (rawBody, ts) => signStripeStyle(secret, ts, rawBody) }, event, timestampSec);
}

/** For helpers handed the gateway double rather than its secret. */
export function signWebhookAs(
  signer: { sign(rawBody: string, timestampSec: number): string },
  event: Record<string, unknown>,
  timestampSec = Math.floor(Date.now() / 1000),
): SignedWebhook {
  const rawBody = JSON.stringify(event);
  return {
    rawBody,
    headers: { [STRIPE_SIGNATURE_HEADER]: signer.sign(rawBody, timestampSec), 'content-type': 'application/json' },
  };
}

/**
 * `checkout.session.completed` settles only when the money cleared AND the amount matches the
 * recorded payment: pass the real amount to settle, a divergent one to exercise refusal. A `null`
 * field means the gateway omitted it entirely, which is distinct from sending a wrong value.
 */
export interface SessionCharge {
  amountMinor: number | null;
  currency: string | null;
  /** `paid` | `no_payment_required` settle; `unpaid` (Stripe's async methods) must not. */
  paymentStatus?: string | null;
}

/** Drives Payment PENDING→SUCCEEDED. `paymentIntent` links session→intent. */
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

/** A manual-capture session completes `unpaid`: Stripe placed a hold and took nothing yet. */
export function manualSessionCompleted(
  sessionId: string,
  charge: { amountMinor: number; currency: string },
  opts: { eventId?: string } = {},
): Record<string, unknown> {
  return checkoutSessionCompleted(sessionId, { ...charge, paymentStatus: 'unpaid' }, opts);
}

/** Drives Payment PENDING→FAILED. */
export function checkoutSessionExpired(sessionId: string, opts: { eventId?: string } = {}): Record<string, unknown> {
  return {
    id: opts.eventId ?? 'evt_test_expired',
    type: 'checkout.session.expired',
    data: { object: { id: sessionId } },
  };
}
