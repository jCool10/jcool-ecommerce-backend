import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import {
  PaymentGatewayError,
  type CaptureResult,
  type CreateSessionInput,
  type ExpireSessionOutcome,
  type GatewaySession,
  type GatewayPaymentStatus,
  type GatewayStatus,
  type IntentStatus,
  type PaymentGatewayPort,
  type RetrievedSession,
  type SessionAuthorization,
  type VerifiedEvent,
  type VoidOutcome,
} from '../../application/ports/payment-gateway.port';
import { FakePaymentIntents, type IntentFault } from './fake-payment-intents';
import { signStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

interface ManualSession {
  status: 'open' | 'complete' | 'expired';
  intentId?: string;
}

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
  private readonly requests = new Map<string, CreateSessionInput>();
  private readonly manual = new Map<string, ManualSession>();
  private readonly holds = new FakePaymentIntents();
  private createDelayMs = 0;
  private expireDelayMs = 0;

  constructor(
    private readonly secret: string,
    private readonly toleranceSec = 300,
  ) {}

  sign(rawBody: Buffer | string, timestampSec: number): string {
    return signStripeStyle(this.secret, timestampSec, rawBody);
  }

  async createSession(input: CreateSessionInput): Promise<GatewaySession> {
    if (this.createDelayMs > 0) await sleep(this.createDelayMs);
    const sessionId = `cs_fake_${uuidv7().replace(/-/g, '')}`;
    // Remembered so a later status probe reports the charge this session holds — the sweep settles
    // only against money that matches the payment row. Lowercased because that is what Stripe echoes
    // back; storing it verbatim would leave the money guard's case-folding unexercised end to end.
    this.charges.set(sessionId, { amountMinor: input.amountMinor, currency: input.currency.toLowerCase() });
    this.requests.set(sessionId, input);
    if (input.captureMethod === 'manual') {
      this.manual.set(sessionId, { status: 'open' });
      this.statuses.set(sessionId, 'PENDING');
    }
    return {
      providerSessionId: sessionId,
      redirectUrl: `https://fake.gateway.test/pay/${sessionId}`,
    };
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

  restorePaymentStatus(ref: string): void {
    this.unreachable.delete(ref);
  }

  failExpireSession(ref: string): void {
    this.unexpirable.add(ref);
  }

  wasExpired(ref: string): boolean {
    return this.expired.has(ref);
  }

  sessionRequest(ref: string): CreateSessionInput | undefined {
    return this.requests.get(ref);
  }

  /** The buyer completes a manual session: Stripe places a hold, by default for the session's charge. */
  authorize(sessionRef: string, charge: { amountMinor?: number; currency?: string } = {}): string {
    const session = this.manual.get(sessionRef);
    if (session?.status !== 'open') {
      throw new Error(`fake gateway has no open manual session ${sessionRef}`);
    }
    const held = { ...this.charges.get(sessionRef)!, ...charge };
    const intentId = this.holds.open(held.amountMinor, held.currency);
    session.status = 'complete';
    session.intentId = intentId;
    this.intents.set(sessionRef, intentId);
    return intentId;
  }

  setIntentStatus(intentId: string, status: IntentStatus): void {
    this.holds.setStatus(intentId, status);
  }

  /** `expired` is not a request fault: the authorization lapsed, and Stripe canceled the hold. */
  failCapture(intentId: string, mode: IntentFault | 'expired'): void {
    if (mode === 'expired') this.holds.setStatus(intentId, 'canceled');
    else this.holds.failNext('capture', intentId, mode);
  }

  failVoid(intentId: string, mode: IntentFault): void {
    this.holds.failNext('void', intentId, mode);
  }

  captureCalls(intentId: string): number {
    return this.holds.captureCalls(intentId);
  }

  wasVoided(intentId: string): boolean {
    return this.holds.wasVoided(intentId);
  }

  requestKeys(intentId: string): readonly string[] {
    return this.holds.requestKeys(intentId);
  }

  delayCreateSession(ms: number): void {
    this.createDelayMs = ms;
  }

  delayExpireSession(ms: number): void {
    this.expireDelayMs = ms;
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

  retrieveSession(ref: string): Promise<RetrievedSession> {
    if (this.unreachable.has(ref)) {
      return Promise.reject(new PaymentGatewayError(`fake gateway unreachable for ${ref}`));
    }
    const status = this.statuses.get(ref) ?? 'UNKNOWN';
    // A completed manual session is still unpaid until capture, but its page no longer takes money.
    const payable = status === 'PENDING' && this.manual.get(ref)?.status !== 'complete';
    return Promise.resolve({
      status,
      redirectUrl: payable ? `https://fake.gateway.test/pay/${ref}` : undefined,
    });
  }

  async expireSession(ref: string): Promise<ExpireSessionOutcome> {
    if (this.expireDelayMs > 0) await sleep(this.expireDelayMs);
    if (this.unexpirable.has(ref)) {
      throw new PaymentGatewayError(`fake gateway refused to expire ${ref}`);
    }
    // Money moved. Reported directly rather than re-enacting the real adapter's refuse-then-read-back
    // round-trips: the point of the double is to put the caller in the same position.
    if (this.statuses.get(ref) === 'PAID' || this.manual.get(ref)?.status === 'complete') {
      return 'already_completed';
    }
    // Re-expiring is routine (the consumer's transaction can roll back after this call landed), and
    // a double answering `expired` twice would hide the difference.
    if (this.expired.has(ref)) {
      return 'already_closed';
    }
    this.expired.add(ref);
    this.statuses.set(ref, 'FAILED');
    const session = this.manual.get(ref);
    if (session) session.status = 'expired';
    return 'expired';
  }

  retrieveAuthorization(sessionRef: string): Promise<SessionAuthorization> {
    if (this.unreachable.has(sessionRef)) {
      return Promise.reject(new PaymentGatewayError(`fake gateway unreachable for ${sessionRef}`));
    }
    const session = this.manual.get(sessionRef);
    if (!session) {
      return Promise.resolve({ sessionStatus: 'unknown' });
    }
    const hold = session.intentId ? this.holds.find(session.intentId) : undefined;
    if (!hold) {
      return Promise.resolve({ sessionStatus: session.status });
    }
    return Promise.resolve({
      sessionStatus: session.status,
      intentId: session.intentId,
      intentStatus: hold.status,
      amountCapturableMinor: hold.status === 'requires_capture' ? hold.amountMinor : 0,
      currency: hold.currency,
    });
  }

  capture(intentId: string, idempotencyKey: string): Promise<CaptureResult> {
    return this.holds.capture(intentId, idempotencyKey);
  }

  void(intentId: string, idempotencyKey: string): Promise<VoidOutcome> {
    return this.holds.void(intentId, idempotencyKey);
  }
}
