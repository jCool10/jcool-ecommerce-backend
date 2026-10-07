// FakeSignerGatewayAdapter implements this alongside StripeGatewayAdapter, which is how e2e exercises
// the webhook path without Stripe's signing key.
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface CreateSessionInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  // Passed to the gateway's own idempotency mechanism when it has one (Stripe: Idempotency-Key
  // header) so a retried session-create call returns the same session instead of a duplicate.
  idempotencyKey?: string;
  /** `manual` only places a hold; the money moves on a later `capture`. Absent → automatic. */
  captureMethod?: 'automatic' | 'manual';
  /** When the hosted page stops taking money. Absent → the configured session floor from now. */
  expiresAt?: Date;
}

export interface GatewaySession {
  providerSessionId: string; // handle persisted on Payment (Stripe: cs_...)
  redirectUrl?: string; // hosted checkout URL, or a VietQR payload for domestic gateways
  clientSecret?: string;
}

// Discriminated so the webhook handler branches on outcome instead of catching an opaque throw.
export type VerifiedEvent =
  | { kind: 'valid'; providerEventId: string; type: string; payload: unknown }
  | { kind: 'invalid_signature' }
  | { kind: 'expired_timestamp' };

/**
 * `UNKNOWN` is distinct from `PENDING` on purpose: the gateway could not answer, which the sweep
 * must not read as "still in progress" once the order is past its TTL.
 */
export type GatewayStatus = 'PAID' | 'FAILED' | 'PENDING' | 'UNKNOWN';

export interface GatewayPaymentStatus {
  status: GatewayStatus;
  /** Carried with the status because a sweep-settled payment has no webhook to record it, and a
   * later refund or dispute needs the handle. */
  intentId?: string | null;
  /** The money this session actually holds. Carried so a sweep can prove a PAID verdict is for the
   * charge on the payment row, the same proof the webhook path demands before settling. */
  amountMinor?: number;
  currency?: string;
}

export type ExpireSessionOutcome =
  | 'expired'
  /** Already unpayable — expired, or never issued. Nothing happened and nothing is owed. */
  | 'already_closed'
  /** The buyer already checked out through it; payment may still be clearing, but nothing to close. */
  | 'already_completed';

export interface RetrievedSession {
  /** Whether the hosted page can still take money. */
  status: GatewayStatus;
  redirectUrl?: string;
  clientSecret?: string;
}

export type IntentStatus =
  'requires_capture' | 'succeeded' | 'canceled' | 'processing' | 'requires_payment_method' | 'other';

export interface SessionAuthorization {
  sessionStatus: 'open' | 'complete' | 'expired' | 'unknown';
  intentId?: string;
  intentStatus?: IntentStatus;
  amountCapturableMinor?: number;
  currency?: string;
}

export type CaptureResult = { kind: 'captured' } | { kind: 'not_capturable'; intentStatus: IntentStatus };

export type VoidOutcome = 'voided' | 'already_canceled' | 'already_captured';

export interface PaymentGatewayPort {
  // Recorded on Payment.provider from the adapter, not config, so the two can never drift.
  readonly provider: string;
  createSession(input: CreateSessionInput): Promise<GatewaySession>;
  // `rawBody` is the exact bytes the gateway signed — verifying a re-serialized body would fail.
  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent;
  /**
   * Network I/O — callers must invoke it OUTSIDE a transaction. An unreachable provider throws
   * rather than answering `UNKNOWN`, which would let a TTL sweep expire an order that was paid.
   */
  getPaymentStatus(ref: string): Promise<GatewayPaymentStatus>;
  /**
   * Re-reads a still-open session's own redirect handle, for a buyer who presses Pay again while a
   * PENDING payment's session is still alive. Distinct from `getPaymentStatus`, which the sweep uses
   * and which never needs a redirect back to the buyer.
   */
  retrieveSession(ref: string): Promise<RetrievedSession>;
  /**
   * Resolves only once the session is guaranteed to take no further money; anything else throws,
   * because the hosted page outlives the order and settling early would charge a buyer for an order
   * that no longer exists. `already_completed` resolves — retrying cannot change it — but owes a
   * human a look.
   */
  expireSession(ref: string): Promise<ExpireSessionOutcome>;
  /** Reads the session with its PaymentIntent expanded. Unconfigured or unrecognised → `unknown`. */
  retrieveAuthorization(sessionRef: string): Promise<SessionAuthorization>;
  /**
   * `idempotencyKey` is `capture:{paymentId}:{gen}`. Resolves only on an outcome Stripe confirmed;
   * an unknown outcome throws and the caller retries with the same key, unless the error asks for a
   * fresh one (`retryWithFreshKey`).
   */
  capture(intentId: string, idempotencyKey: string): Promise<CaptureResult>;
  /** `idempotencyKey` is `void:{paymentId}:{gen}`; same contract as `capture`. */
  void(intentId: string, idempotencyKey: string): Promise<VoidOutcome>;
}

// An upstream provider fault (→ 502), kept distinct from the domain 4xx a bad request raises.
export class PaymentGatewayError extends Error {
  /**
   * Stripe stores a 5xx against its idempotency key and replays it for every resend, so a hold that
   * is still capturable can only be reached again under a new key.
   */
  readonly retryWithFreshKey: boolean;

  constructor(
    message: string,
    readonly cause?: unknown,
    options: { retryWithFreshKey?: boolean } = {},
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.retryWithFreshKey = options.retryWithFreshKey ?? false;
  }
}
