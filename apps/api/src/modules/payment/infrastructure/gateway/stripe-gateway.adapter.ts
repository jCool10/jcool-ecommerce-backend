import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
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
import { verifyAndParseStripeEvent } from './hmac-signature';
import { isSessionNotOpen, isStripeServerError, isUnexpectedIntentState } from './stripe-fault-classification';

type StripeClient = Pick<Stripe, 'checkout' | 'paymentIntents'>;

export interface StripeGatewayOptions {
  webhookSecret?: string;
  toleranceSec: number;
  // When `secretKey` is set (or `stripeClient` injected) createSession calls the real Stripe API and
  // the persisted cs_... is a genuine Checkout Session a real webhook can settle. Absent → the
  // network-free coded path, which never touches Stripe and can never settle for real.
  secretKey?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** Lifetime of a session opened without an explicit `expiresAt`: the floor plus the margin. */
  sessionMinTtlSec: number;
  sessionExpiryMarginSec: number;
  /** Bounds each capture, void, expire and authorization read; the SDK does not retry them. */
  captureTimeoutMs: number;
  // Test seam: inject a Stripe-shaped client so the live branch is covered without a key or network.
  stripeClient?: StripeClient;
}

const KNOWN_INTENT_STATUSES: ReadonlySet<string> = new Set<IntentStatus>([
  'requires_capture',
  'succeeded',
  'canceled',
  'processing',
  'requires_payment_method',
]);

@Injectable()
export class StripeGatewayAdapter implements PaymentGatewayPort {
  readonly provider = 'stripe';
  private readonly webhookSecret: string;
  private readonly toleranceSec: number;
  private readonly stripe?: StripeClient;
  private readonly successUrl?: string;
  private readonly cancelUrl?: string;
  private readonly sessionLifetimeSec: number;
  // Retries belong to the caller (saga, sweep), which knows how long it can wait.
  private readonly bounded: Stripe.RequestOptions;

  constructor(options: StripeGatewayOptions) {
    // Fail-fast on the real path: a missing/blank webhook secret would silently accept forged
    // events, so refuse to construct instead of booting a gateway that can't verify anything.
    if (!options.webhookSecret || options.webhookSecret.trim() === '') {
      throw new Error('PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=stripe');
    }
    // A non-finite/negative window would make the replay check `Math.abs(...) > NaN` always false,
    // silently disabling replay defense — as dangerous as a missing secret, so fail-fast too.
    if (!Number.isFinite(options.toleranceSec) || options.toleranceSec < 0) {
      throw new Error('PAYMENT_WEBHOOK_TOLERANCE_SEC must be a non-negative number');
    }
    this.webhookSecret = options.webhookSecret;
    this.toleranceSec = options.toleranceSec;
    this.sessionLifetimeSec = options.sessionMinTtlSec + options.sessionExpiryMarginSec;
    this.bounded = { timeout: options.captureTimeoutMs, maxNetworkRetries: 0 };

    const secretKey = options.secretKey?.trim();
    this.stripe =
      options.stripeClient ??
      (secretKey
        ? new Stripe(secretKey, {
            maxNetworkRetries: 2,
            timeout: 20_000,
            appInfo: { name: 'jcool-ecommerce-backend' },
          })
        : undefined);

    if (this.stripe) {
      // Stripe rejects checkout.sessions.create without a success_url — fail-fast at boot rather
      // than surfacing the provider's 400 on the first real checkout.
      if (!options.successUrl || options.successUrl.trim() === '') {
        throw new Error('STRIPE_SUCCESS_URL is required when STRIPE_SECRET_KEY is set');
      }
      this.successUrl = options.successUrl;
      this.cancelUrl = options.cancelUrl;
    }
  }

  async createSession(input: CreateSessionInput): Promise<GatewaySession> {
    if (!this.stripe) {
      // Offline coded path: no live key configured. Real settlement requires STRIPE_SECRET_KEY.
      const sessionId = `cs_test_${uuidv7().replace(/-/g, '')}`;
      return { providerSessionId: sessionId, redirectUrl: `https://checkout.stripe.test/pay/${sessionId}` };
    }

    const expiresAtSec = input.expiresAt
      ? Math.floor(input.expiresAt.getTime() / 1000)
      : Math.floor(Date.now() / 1000) + this.sessionLifetimeSec;
    try {
      // One line item for the order's frozen total: the amount is snapshotted server-side, so no
      // per-item breakdown is needed to collect it.
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.amountMinor,
                product_data: { name: `Order ${input.orderId}` },
              },
            },
          ],
          success_url: this.successUrl!,
          cancel_url: this.cancelUrl,
          client_reference_id: input.orderId,
          metadata: { order_id: input.orderId },
          expires_at: expiresAtSec,
          ...(input.captureMethod === 'manual' ? { payment_intent_data: { capture_method: 'manual' as const } } : {}),
        },
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
      );
      return { providerSessionId: session.id, redirectUrl: session.url ?? undefined };
    } catch (error) {
      throw new PaymentGatewayError(`Stripe checkout session create failed (${describe(error)})`, error);
    }
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return verifyAndParseStripeEvent({
      secret: this.webhookSecret,
      toleranceSec: this.toleranceSec,
      rawBody,
      headers,
    });
  }

  async getPaymentStatus(ref: string): Promise<GatewayPaymentStatus> {
    // Offline: the fabricated handle exists nowhere at Stripe. UNKNOWN, not PENDING, so the TTL
    // sweep can still settle the order.
    if (!this.stripe) {
      return { status: 'UNKNOWN' };
    }

    const session = await this.fetchSession(ref);
    if (session === null) {
      return { status: 'UNKNOWN' };
    }
    return {
      status: mapSessionStatus(session),
      intentId: extractIntentId(session),
      amountMinor: session.amount_total ?? undefined,
      currency: session.currency ?? undefined,
    };
  }

  async retrieveSession(ref: string): Promise<RetrievedSession> {
    // Offline: nothing to reuse — the caller opens a fresh (also fabricated) session instead.
    if (!this.stripe) {
      return { status: 'UNKNOWN' };
    }

    const session = await this.fetchSession(ref);
    if (session === null) {
      return { status: 'UNKNOWN' };
    }
    return { status: mapSessionStatus(session), redirectUrl: session.url ?? undefined };
  }

  // `null` for an unrecognised handle. Every other fault throws, so an outage is never read as
  // "not paid" and used to expire a settled order.
  private async fetchSession(ref: string): Promise<Stripe.Checkout.Session | null> {
    try {
      return await this.stripe!.checkout.sessions.retrieve(ref);
    } catch (error) {
      if (isUnknownHandle(error)) {
        return null;
      }
      throw new PaymentGatewayError(`Stripe checkout session retrieve failed (${describe(error)})`, error);
    }
  }

  async expireSession(ref: string): Promise<ExpireSessionOutcome> {
    // Offline coded path: the fabricated handle was never payable in the first place.
    if (!this.stripe) {
      return 'expired';
    }

    try {
      await this.stripe.checkout.sessions.expire(ref, undefined, this.bounded);
      return 'expired';
    } catch (error) {
      if (isUnknownHandle(error)) {
        return 'already_closed';
      }
      if (!isSessionNotOpen(error)) {
        throw new PaymentGatewayError(`Stripe checkout session expire failed (${describe(error)})`, error);
      }
      // Stripe gives the same refusal whether the session took money or simply lapsed — a refund and
      // a no-op. Reading it back is the only way to tell them apart.
      return this.classifyRefusal(ref, error);
    }
  }

  private async classifyRefusal(ref: string, refusal: unknown): Promise<ExpireSessionOutcome> {
    let status: Stripe.Checkout.Session['status'];
    try {
      const session = await this.stripe!.checkout.sessions.retrieve(ref, undefined, this.bounded);
      status = session.status;
    } catch (error) {
      if (isUnknownHandle(error)) {
        return 'already_closed';
      }
      throw new PaymentGatewayError(`Stripe checkout session retrieve failed (${describe(error)})`, error);
    }

    // `complete` is the money signal, NOT `payment_status`: an async method leaves a completed
    // session `unpaid` while it clears, and calling that closed loses the refund alarm.
    if (status === 'complete') {
      return 'already_completed';
    }
    if (status === 'expired') {
      return 'already_closed';
    }
    // Refused while still open — a reason we do not model. Retrying is the honest response.
    throw new PaymentGatewayError(`Stripe refused to expire an open checkout session (${describe(refusal)})`, refusal);
  }

  async retrieveAuthorization(sessionRef: string): Promise<SessionAuthorization> {
    if (!this.stripe) {
      return { sessionStatus: 'unknown' };
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(sessionRef, { expand: ['payment_intent'] }, this.bounded);
    } catch (error) {
      if (isUnknownHandle(error)) {
        return { sessionStatus: 'unknown' };
      }
      throw new PaymentGatewayError(`Stripe checkout session retrieve failed (${describe(error)})`, error);
    }

    // Under manual capture a held session reads `complete` + `unpaid`; only the intent shows the hold.
    const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
    return {
      sessionStatus: toSessionStatus(session.status),
      redirectUrl: session.url ?? undefined,
      intentId: intent?.id ?? extractIntentId(session) ?? undefined,
      intentStatus: intent ? toIntentStatus(intent.status) : undefined,
      amountCapturableMinor: intent?.amount_capturable,
      currency: intent?.currency,
    };
  }

  async captureIntent(intentId: string, idempotencyKey: string): Promise<CaptureIntentResult> {
    const stripe = this.requireLive('capture');
    try {
      await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey, ...this.bounded });
      return { kind: 'captured' };
    } catch (error) {
      const status = await this.readIntentAfter('capture', intentId, error);
      if (status === 'succeeded') return { kind: 'captured' };
      if (status === 'canceled' || status === 'requires_payment_method') {
        return { kind: 'not_capturable', intentStatus: status };
      }
      throw this.unresolved('capture', status, error);
    }
  }

  async voidIntent(intentId: string, idempotencyKey: string): Promise<VoidIntentOutcome> {
    const stripe = this.requireLive('void');
    try {
      await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey, ...this.bounded });
      return 'voided';
    } catch (error) {
      const status = await this.readIntentAfter('void', intentId, error);
      if (status === 'canceled') return 'already_canceled';
      if (status === 'succeeded') return 'already_captured';
      throw this.unresolved('void', status, error);
    }
  }

  private requireLive(op: string): StripeClient {
    if (!this.stripe) {
      throw new PaymentGatewayError(`Stripe is not configured; cannot ${op} a PaymentIntent`);
    }
    return this.stripe;
  }

  /**
   * Only a 5xx or an "unexpected state" refusal is worth reading back. A timeout, a 409 for the same
   * key still in flight, a 429 or any other refusal is an unknown outcome: thrown, key kept.
   */
  private async readIntentAfter(op: 'capture' | 'void', intentId: string, error: unknown): Promise<IntentStatus> {
    if (!isStripeServerError(error) && !isUnexpectedIntentState(error)) {
      throw new PaymentGatewayError(`Stripe ${op} failed (${describe(error)})`, error);
    }
    try {
      const intent = await this.stripe!.paymentIntents.retrieve(intentId, undefined, this.bounded);
      return toIntentStatus(intent.status);
    } catch (readError) {
      throw new PaymentGatewayError(
        `Stripe ${op} failed (${describe(error)}) and the intent could not be read back (${describe(readError)})`,
        error,
      );
    }
  }

  // A hold still in place after a 5xx means the call did not land, yet Stripe replays that 5xx for
  // the same key: the caller must move to a new one.
  private unresolved(op: 'capture' | 'void', status: IntentStatus, error: unknown): PaymentGatewayError {
    return new PaymentGatewayError(`Stripe ${op} failed with the intent ${status} (${describe(error)})`, error, {
      retryWithFreshKey: status === 'requires_capture' && isStripeServerError(error),
    });
  }
}

// An `expired` session maps to FAILED so it reconciles to the same order state its
// `checkout.session.expired` webhook would have produced.
function mapSessionStatus(session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'>): GatewayStatus {
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    return 'PAID';
  }
  if (session.status === 'expired') {
    return 'FAILED';
  }
  // `open`, or `complete` while an async payment method is still clearing.
  if (session.status === 'open' || session.status === 'complete') {
    return 'PENDING';
  }
  return 'UNKNOWN';
}

function toIntentStatus(status: string): IntentStatus {
  return KNOWN_INTENT_STATUSES.has(status) ? (status as IntentStatus) : 'other';
}

function toSessionStatus(status: string | null): SessionAuthorization['sessionStatus'] {
  return status === 'open' || status === 'complete' || status === 'expired' ? status : 'unknown';
}

// `payment_intent` is a bare id unless the caller expanded it; both shapes yield the same handle.
function extractIntentId(session: Pick<Stripe.Checkout.Session, 'payment_intent'>): string | null {
  const intent = session.payment_intent;
  if (typeof intent === 'string') return intent;
  return intent?.id ?? null;
}

function isUnknownHandle(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404;
}

function describe(error: unknown): string {
  return error instanceof Stripe.errors.StripeError ? `${error.type}: ${error.message}` : String(error);
}
