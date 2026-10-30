import { v7 as uuidv7 } from 'uuid';
import {
  PaymentGatewayError,
  type CaptureIntentResult,
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
  type VoidIntentOutcome,
} from '../../application/ports/payment-gateway.port';
import { signStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

/**
 * How the next capture or void of an intent goes wrong, as the real adapter would report it:
 * - `server_error`: Stripe stores a 5xx under the key without applying it, and replays it for that key.
 * - `applied_then_500`: applied, then a 5xx; the adapter reads the intent back and sees it done.
 * - `timeout`: applied at Stripe, but the answer never arrives.
 * - `idempotency_in_flight`: a 409 for a request with the same key still running; nothing stored.
 * - `expired` (capture only): the hold lapsed before the capture.
 */
export type FakeIntentFault = 'server_error' | 'applied_then_500' | 'timeout' | 'idempotency_in_flight' | 'expired';

interface FakeIntent {
  status: IntentStatus;
  amountMinor: number;
  currency: string;
  captures: number;
  voided: boolean;
}

type StoredResponse = { ok: CaptureIntentResult | VoidIntentOutcome } | { serverError: true };

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
  private readonly holds = new Map<string, FakeIntent>();
  private readonly responses = new Map<string, StoredResponse>();
  private readonly captureFaults = new Map<string, FakeIntentFault>();
  private readonly voidFaults = new Map<string, FakeIntentFault>();
  private lastCreateInput?: CreateSessionInput;
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
    this.lastCreateInput = input;
    await this.consumeDelay('create');
    const sessionId = `cs_fake_${uuidv7().replace(/-/g, '')}`;
    // Remembered so a later status probe reports the charge this session holds — the sweep settles
    // only against money that matches the payment row. Lowercased because that is what Stripe echoes
    // back; storing it verbatim would leave the money guard's case-folding unexercised end to end.
    this.charges.set(sessionId, { amountMinor: input.amountMinor, currency: input.currency.toLowerCase() });
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

  /** The buyer completes a manual-capture session: the card now holds the charge (or the one given). */
  authorize(
    sessionRef: string,
    charge: { amountMinor?: number; currency?: string; intentStatus?: IntentStatus } = {},
  ): string {
    const issued = this.charges.get(sessionRef);
    const intentId = `pi_fake_${uuidv7().replace(/-/g, '')}`;
    this.intents.set(sessionRef, intentId);
    this.holds.set(intentId, {
      status: charge.intentStatus ?? 'requires_capture',
      amountMinor: charge.amountMinor ?? issued?.amountMinor ?? 0,
      currency: (charge.currency ?? issued?.currency ?? 'vnd').toLowerCase(),
      captures: 0,
      voided: false,
    });
    return intentId;
  }

  intentOf(sessionRef: string): string | undefined {
    return this.intents.get(sessionRef);
  }

  /** The session dies on Stripe's own clock, without anyone asking. */
  lapseSession(ref: string): void {
    this.expired.add(ref);
    this.statuses.set(ref, 'FAILED');
  }

  failCapture(intentId: string, fault: FakeIntentFault): void {
    this.captureFaults.set(intentId, fault);
  }

  failVoid(intentId: string, fault: Exclude<FakeIntentFault, 'expired'>): void {
    this.voidFaults.set(intentId, fault);
  }

  /** Captures Stripe actually applied, whatever the caller was told. */
  captureCalls(intentId: string): number {
    return this.holds.get(intentId)?.captures ?? 0;
  }

  wasVoided(intentId: string): boolean {
    return this.holds.get(intentId)?.voided ?? false;
  }

  lastCreateSessionInput(): CreateSessionInput | undefined {
    return this.lastCreateInput;
  }

  /** The next session create waits this long before answering. */
  delayCreateSession(ms: number): void {
    this.createDelayMs = ms;
  }

  /** The next session expire waits this long before answering. */
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
    return Promise.resolve({
      status,
      redirectUrl: status === 'PENDING' ? `https://fake.gateway.test/pay/${ref}` : undefined,
    });
  }

  async expireSession(ref: string): Promise<ExpireSessionOutcome> {
    await this.consumeDelay('expire');
    if (this.unexpirable.has(ref)) {
      throw new PaymentGatewayError(`fake gateway refused to expire ${ref}`);
    }
    // Money moved. Reported directly rather than re-enacting the real adapter's refuse-then-read-back
    // round-trips: the point of the double is to put the caller in the same position.
    if (this.statuses.get(ref) === 'PAID' || this.intents.has(ref)) {
      return 'already_completed';
    }
    // Re-expiring is routine (the consumer's transaction can roll back after this call landed), and
    // a double answering `expired` twice would hide the difference.
    if (this.expired.has(ref)) {
      return 'already_closed';
    }
    this.expired.add(ref);
    this.statuses.set(ref, 'FAILED');
    return 'expired';
  }

  retrieveAuthorization(sessionRef: string): Promise<SessionAuthorization> {
    if (this.unreachable.has(sessionRef)) {
      return Promise.reject(new PaymentGatewayError(`fake gateway unreachable for ${sessionRef}`));
    }
    const intentId = this.intents.get(sessionRef);
    const hold = intentId ? this.holds.get(intentId) : undefined;
    if (intentId && hold) {
      return Promise.resolve({
        sessionStatus: 'complete',
        intentId,
        intentStatus: hold.status,
        amountCapturableMinor: hold.status === 'requires_capture' ? hold.amountMinor : 0,
        currency: hold.currency,
      });
    }
    if (this.expired.has(sessionRef)) return Promise.resolve({ sessionStatus: 'expired' });
    if (this.charges.has(sessionRef)) {
      return Promise.resolve({ sessionStatus: 'open', redirectUrl: `https://fake.gateway.test/pay/${sessionRef}` });
    }
    return Promise.resolve({ sessionStatus: 'unknown' });
  }

  captureIntent(intentId: string, idempotencyKey: string): Promise<CaptureIntentResult> {
    return this.settle(intentId, idempotencyKey, this.captureFaults, (hold) => {
      if (hold.status === 'requires_capture') {
        hold.status = 'succeeded';
        hold.captures += 1;
        return { kind: 'captured' };
      }
      return hold.status === 'succeeded' ? { kind: 'captured' } : { kind: 'not_capturable', intentStatus: hold.status };
    });
  }

  voidIntent(intentId: string, idempotencyKey: string): Promise<VoidIntentOutcome> {
    return this.settle(intentId, idempotencyKey, this.voidFaults, (hold) => {
      if (hold.status === 'succeeded') return 'already_captured';
      if (hold.status === 'canceled') return 'already_canceled';
      hold.status = 'canceled';
      hold.voided = true;
      return 'voided';
    });
  }

  private settle<T extends CaptureIntentResult | VoidIntentOutcome>(
    intentId: string,
    key: string,
    faults: Map<string, FakeIntentFault>,
    apply: (hold: FakeIntent) => T,
  ): Promise<T> {
    // Thrown faults surface as rejections, like the real adapter's.
    return new Promise((resolve) => resolve(this.respond(intentId, key, faults, apply)));
  }

  // Mirrors Stripe's idempotency: the first response under a key, error or not, is the response.
  private respond<T extends CaptureIntentResult | VoidIntentOutcome>(
    intentId: string,
    key: string,
    faults: Map<string, FakeIntentFault>,
    apply: (hold: FakeIntent) => T,
  ): T {
    const hold = this.holds.get(intentId);
    if (!hold) throw new PaymentGatewayError(`fake gateway has no intent ${intentId}`);

    const stored = this.responses.get(key);
    if (stored) return this.replay(hold, stored, apply);

    const fault = faults.get(intentId);
    faults.delete(intentId);
    switch (fault) {
      case 'idempotency_in_flight':
        throw new PaymentGatewayError(`fake gateway: a request with key ${key} is still in flight`);
      case 'server_error':
        this.responses.set(key, { serverError: true });
        return this.replay(hold, { serverError: true }, apply);
      case 'applied_then_500':
        apply(hold);
        this.responses.set(key, { serverError: true });
        return this.replay(hold, { serverError: true }, apply);
      case 'timeout':
        this.responses.set(key, { ok: apply(hold) });
        throw new PaymentGatewayError(`fake gateway: request with key ${key} timed out`);
      case 'expired':
        hold.status = 'canceled';
        break;
    }
    const result = apply(hold);
    this.responses.set(key, { ok: result });
    return result;
  }

  // A stored 5xx makes the adapter read the intent back: done reads as done, a hold still in place
  // asks for a fresh key.
  private replay<T>(hold: FakeIntent, stored: StoredResponse, apply: (hold: FakeIntent) => T): T {
    if ('ok' in stored) return stored.ok as T;
    if (hold.status === 'requires_capture') {
      throw new PaymentGatewayError('fake gateway: 500 stored under this key', undefined, { retryWithFreshKey: true });
    }
    return apply(hold);
  }

  private async consumeDelay(call: 'create' | 'expire'): Promise<void> {
    const ms = call === 'create' ? this.createDelayMs : this.expireDelayMs;
    if (call === 'create') this.createDelayMs = 0;
    else this.expireDelayMs = 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
