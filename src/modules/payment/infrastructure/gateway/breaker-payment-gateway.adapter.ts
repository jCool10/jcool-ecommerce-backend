import { DownstreamUnavailableError, type OutboundCall } from '@shared/resilience';
import {
  PaymentGatewayError,
  type CreateSessionInput,
  type ExpireSessionOutcome,
  type GatewayPaymentStatus,
  type GatewaySession,
  type PaymentGatewayPort,
  type VerifiedEvent,
} from '../../application/ports/payment-gateway.port';

/** Metric label, so it stays a fixed name rather than anything derived per call. */
export const PAYMENT_GATEWAY_BREAKER = 'payment_gateway';

/**
 * Fronts the real gateway with a circuit breaker, so a provider outage costs us one fast failure per
 * call instead of one held request slot per call.
 *
 * Only the three methods that cross the network go through it. `verifyAndParseEvent` is local HMAC
 * work: guarding it would let an outage of the gateway's API stop us verifying the webhooks that
 * same gateway is still delivering — the one path that still settles orders while it is down.
 *
 * A refusal comes back out as `PaymentGatewayError`, the port's own word for "the provider did not
 * answer", so every caller keeps the handling it already has: checkout answers 502, the reconcile
 * sweep leaves the order for its next tick, and the expiry consumer retries its message. Nothing
 * degrades into a value — a fabricated `UNKNOWN` from `getPaymentStatus` would let the reconcile
 * sweep expire an order that had in fact been paid.
 */
export class BreakerPaymentGateway implements PaymentGatewayPort {
  readonly provider: string;

  constructor(
    private readonly inner: PaymentGatewayPort,
    private readonly breaker: OutboundCall,
  ) {
    this.provider = inner.provider;
  }

  createSession(input: CreateSessionInput): Promise<GatewaySession> {
    return this.guard('create a checkout session', () => this.inner.createSession(input));
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return this.inner.verifyAndParseEvent(rawBody, headers);
  }

  getPaymentStatus(ref: string): Promise<GatewayPaymentStatus> {
    return this.guard('report a payment status', () => this.inner.getPaymentStatus(ref));
  }

  expireSession(ref: string): Promise<ExpireSessionOutcome> {
    return this.guard('expire a session', () => this.inner.expireSession(ref));
  }

  private async guard<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.run(call);
    } catch (error) {
      if (error instanceof DownstreamUnavailableError) {
        throw new PaymentGatewayError(`gateway could not ${what}: ${error.message}`, error);
      }
      throw error;
    }
  }
}
