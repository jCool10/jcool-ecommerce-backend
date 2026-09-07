// Swapping the provider is a DI change, never a caller change. The port is not speculative: two
// adapters already implement it — StripeGatewayAdapter in production and FakeSignerGatewayAdapter
// in e2e, which is how the webhook path is tested without Stripe's signing key.
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
}

/** What closing a session turned out to mean. The adapter resolves it, so no caller has to guess. */
export type ExpireSessionOutcome =
  /** This call closed it. */
  | 'expired'
  /** Already unpayable — expired, or never issued. Nothing happened and nothing is owed. */
  | 'already_closed'
  /**
   * The buyer has already checked out through it. Payment may still be clearing (an async method
   * leaves a completed session unpaid for a while), but the decision is the same either way.
   */
  | 'already_completed';

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
   * Resolves only once the session is guaranteed to take no further money; anything else throws,
   * because the hosted page outlives the order and settling early would charge a buyer for an order
   * that no longer exists. `already_completed` resolves — retrying cannot change it — but owes a
   * human a look.
   */
  expireSession(ref: string): Promise<ExpireSessionOutcome>;
}

// An upstream provider fault (→ 502), kept distinct from the domain 4xx a bad request raises.
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}
