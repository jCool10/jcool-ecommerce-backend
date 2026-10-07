import { DownstreamUnavailableError, type CircuitBreakerFactory, type OutboundCall } from '@jcool/platform/resilience';
import {
  PaymentGatewayError,
  type CaptureResult,
  type CreateSessionInput,
  type ExpireSessionOutcome,
  type GatewayPaymentStatus,
  type GatewaySession,
  type PaymentGatewayPort,
  type RetrievedSession,
  type SessionAuthorization,
  type VerifiedEvent,
  type VoidOutcome,
} from '../../application/ports/payment-gateway.port';

export const PAYMENT_GATEWAY_BREAKER = 'payment_gateway';
export const PAYMENT_CAPTURE_BREAKER = 'payment_capture';

/**
 * Only the methods that cross the network go through a breaker. `verifyAndParseEvent` is local
 * HMAC work: guarding it would let an outage of the gateway's API stop us verifying the webhooks that
 * same gateway is still delivering — the one path that still settles orders while it is down.
 *
 * Capture and void get their own breaker: a capture plus its read-back may healthily take longer than
 * the shared timeout, and abandoning it there would also trip the circuit checkout depends on.
 *
 * A refusal comes back out as `PaymentGatewayError`, so every caller keeps the handling it already has.
 * Nothing degrades into a value: a fabricated `UNKNOWN` from `getPaymentStatus` would let the reconcile
 * sweep expire an order that had in fact been paid.
 */
export class BreakerPaymentGateway implements PaymentGatewayPort {
  readonly provider: string;

  constructor(
    private readonly inner: PaymentGatewayPort,
    private readonly breaker: OutboundCall,
    private readonly captureBreaker: OutboundCall,
  ) {
    this.provider = inner.provider;
  }

  createSession(input: CreateSessionInput): Promise<GatewaySession> {
    return this.guard(this.breaker, 'create a checkout session', () => this.inner.createSession(input));
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return this.inner.verifyAndParseEvent(rawBody, headers);
  }

  getPaymentStatus(ref: string): Promise<GatewayPaymentStatus> {
    return this.guard(this.breaker, 'report a payment status', () => this.inner.getPaymentStatus(ref));
  }

  retrieveSession(ref: string): Promise<RetrievedSession> {
    return this.guard(this.breaker, 'retrieve a checkout session', () => this.inner.retrieveSession(ref));
  }

  expireSession(ref: string): Promise<ExpireSessionOutcome> {
    return this.guard(this.breaker, 'expire a session', () => this.inner.expireSession(ref));
  }

  retrieveAuthorization(sessionRef: string): Promise<SessionAuthorization> {
    return this.guard(this.breaker, 'retrieve an authorization', () => this.inner.retrieveAuthorization(sessionRef));
  }

  capture(intentId: string, idempotencyKey: string): Promise<CaptureResult> {
    return this.guard(this.captureBreaker, 'capture a payment', () => this.inner.capture(intentId, idempotencyKey));
  }

  void(intentId: string, idempotencyKey: string): Promise<VoidOutcome> {
    return this.guard(this.captureBreaker, 'void a payment', () => this.inner.void(intentId, idempotencyKey));
  }

  private async guard<T>(breaker: OutboundCall, what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await breaker.run(call);
    } catch (error) {
      if (error instanceof DownstreamUnavailableError) {
        throw new PaymentGatewayError(`gateway could not ${what}: ${error.message}`, error);
      }
      throw error;
    }
  }
}

export interface PaymentBreakerOptions {
  /** Per-request bound of capture and void; each may make two requests (the call and a read-back). */
  captureTimeoutMs: number;
  isDownstreamFault: (error: unknown) => boolean;
}

export function guardPaymentGateway(
  inner: PaymentGatewayPort,
  breakers: CircuitBreakerFactory,
  { captureTimeoutMs, isDownstreamFault }: PaymentBreakerOptions,
): BreakerPaymentGateway {
  return new BreakerPaymentGateway(
    inner,
    breakers.create(PAYMENT_GATEWAY_BREAKER, { isDownstreamFault }),
    breakers.create(PAYMENT_CAPTURE_BREAKER, { isDownstreamFault, timeoutMs: 2 * captureTimeoutMs + 1_000 }),
  );
}
