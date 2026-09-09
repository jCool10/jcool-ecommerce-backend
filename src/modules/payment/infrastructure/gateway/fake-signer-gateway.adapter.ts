import { v7 as uuidv7 } from 'uuid';
import {
  PaymentGatewayError,
  type CreateSessionInput,
  type ExpireSessionOutcome,
  type GatewaySession,
  type GatewayPaymentStatus,
  type GatewayStatus,
  type PaymentGatewayPort,
  type VerifiedEvent,
} from '../../application/ports/payment-gateway.port';
import { signStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

/**
 * Deterministic gateway double for tests and local dev. It signs and verifies for real, sharing
 * hmac-signature.ts with the Stripe adapter so the scheme can never drift, which lets integration
 * tests build validly / invalidly / expired-signed webhook fixtures offline.
 */
export class FakeSignerGatewayAdapter implements PaymentGatewayPort {
  // Emulates the Stripe scheme, so a payment it creates is recorded under the same provider key.
  readonly provider = 'stripe';
  private readonly statuses = new Map<string, GatewayStatus>();
  private readonly intents = new Map<string, string>();
  private readonly charges = new Map<string, { amountMinor: number; currency: string }>();
  private readonly unreachable = new Set<string>();
  private readonly unexpirable = new Set<string>();
  private readonly expired = new Set<string>();

  constructor(
    private readonly secret: string,
    private readonly toleranceSec = 300,
  ) {}

  sign(rawBody: Buffer | string, timestampSec: number): string {
    return signStripeStyle(this.secret, timestampSec, rawBody);
  }

  createSession(input: CreateSessionInput): Promise<GatewaySession> {
    const sessionId = `cs_fake_${uuidv7().replace(/-/g, '')}`;
    // Remembered so a later status probe reports the charge this session holds — the sweep settles
    // only against money that matches the payment row. Lowercased because that is what Stripe echoes
    // back; storing it verbatim would leave the money guard's case-folding unexercised end to end.
    this.charges.set(sessionId, { amountMinor: input.amountMinor, currency: input.currency.toLowerCase() });
    return Promise.resolve({
      providerSessionId: sessionId,
      redirectUrl: `https://fake.gateway.test/pay/${sessionId}`,
    });
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return verifyAndParseStripeEvent({
      secret: this.secret,
      toleranceSec: this.toleranceSec,
      rawBody,
      headers,
    });
  }

  setPaymentStatus(ref: string, status: GatewayStatus, intentId?: string): void {
    this.statuses.set(ref, status);
    if (intentId !== undefined) {
      this.intents.set(ref, intentId);
    }
  }

  /** Stages an outage: the status query throws, as a real one would, rather than answering UNKNOWN. */
  failPaymentStatus(ref: string): void {
    this.unreachable.add(ref);
  }

  failExpireSession(ref: string): void {
    this.unexpirable.add(ref);
  }

  wasExpired(ref: string): boolean {
    return this.expired.has(ref);
  }

  getPaymentStatus(ref: string): Promise<GatewayPaymentStatus> {
    if (this.unreachable.has(ref)) {
      return Promise.reject(new PaymentGatewayError(`fake gateway unreachable for ${ref}`));
    }
    // Unstaged handles read UNKNOWN, as a real gateway answers for one it never issued.
    return Promise.resolve({
      status: this.statuses.get(ref) ?? 'UNKNOWN',
      intentId: this.intents.get(ref) ?? null,
      ...this.charges.get(ref),
    });
  }

  expireSession(ref: string): Promise<ExpireSessionOutcome> {
    if (this.unexpirable.has(ref)) {
      return Promise.reject(new PaymentGatewayError(`fake gateway refused to expire ${ref}`));
    }
    // Money moved. Reported directly rather than re-enacting the real adapter's refuse-then-read-back
    // round-trips: the point of the double is to put the caller in the same position.
    if (this.statuses.get(ref) === 'PAID') {
      return Promise.resolve('already_completed');
    }
    // Re-expiring is routine (the consumer's transaction can roll back after this call landed), and
    // a double answering `expired` twice would hide the difference.
    if (this.expired.has(ref)) {
      return Promise.resolve('already_closed');
    }
    this.expired.add(ref);
    this.statuses.set(ref, 'FAILED');
    return Promise.resolve('expired');
  }
}
