// Payment gateway port — the single seam session creation and webhook verification depend on.
// Swapping the provider is a DI + env change, never a caller change. The Stripe-style HMAC adapter
// is the coded path; SePay/VietQR stays interface-only.
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface CreateSessionInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  // Passed to the gateway's own idempotency mechanism when it has one (Stripe: Idempotency-Key
  // header) so a retried session-create call returns the same session instead of a duplicate.
  idempotencyKey?: string;
}

export interface GatewaySession {
  providerSessionId: string; // handle persisted on Payment (Stripe: cs_...)
  redirectUrl?: string; // hosted checkout URL, or a VietQR payload for domestic gateways
  clientSecret?: string; // PaymentIntent client_secret, when the flow uses one
}

// Discriminated result so the webhook handler branches on outcome instead of catching an opaque
// throw: a forged/tampered body is `invalid_signature`, a replayed/clock-skewed one is
// `expired_timestamp`, and only `valid` carries the parsed event.
export type VerifiedEvent =
  | { kind: 'valid'; providerEventId: string; type: string; payload: unknown }
  | { kind: 'invalid_signature' }
  | { kind: 'expired_timestamp' };

export interface PaymentGatewayPort {
  // Provider key recorded on Payment.provider — the adapter is authoritative, so the persisted
  // value can't drift from the gateway the DI factory actually built (config could).
  readonly provider: string;
  createSession(input: CreateSessionInput): Promise<GatewaySession>;
  // `rawBody` is the exact bytes the gateway signed — verifying a re-serialized body would fail.
  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent;
}

// The gateway's own API (e.g. a live Stripe session-create) failed — an upstream/provider fault the
// caller maps to 502, kept distinct from the domain 4xx a bad request raises. Carries the original
// error as `cause` for the log, never surfaced to the client.
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}
