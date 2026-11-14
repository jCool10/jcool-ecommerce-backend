import Stripe from 'stripe';
import type { ReportedRefundStatus } from '../../domain/refund-settlement';
import {
  PaymentGatewayError,
  type ProviderRefund,
  type RefundIntentInput,
} from '../../application/ports/payment-gateway.port';
import { hasStripeCode, isStripeRequestInFlight, isStripeServerError } from './stripe-fault-classification';

export type StripeRefunds = Pick<Stripe['refunds'], 'create' | 'list' | 'retrieve'>;

/**
 * Error codes (documented by Stripe, unlike its wording) no retry can turn into a refund.
 * `amount_too_large` means part of the charge was already refunded elsewhere.
 */
const FINAL_REFUSALS = ['amount_too_large', 'charge_disputed', 'refund_disputed_payment'];

const KNOWN_STATUSES: ReadonlySet<string> = new Set<ReportedRefundStatus>([
  'succeeded',
  'pending',
  'requires_action',
  'failed',
  'canceled',
]);

// Stripe allows 100 per page; a charge never carries anywhere near that many refunds.
const LIST_LIMIT = 100;

/**
 * Every refund is found through the order's PaymentIntent, never through metadata: a refund made in
 * the dashboard carries none. Metadata only cross-checks, and a refund naming another order is never
 * adopted, so a mix-up keeps the caller retrying where an operator can see it.
 */
export class StripeRefundCalls {
  constructor(
    private readonly refunds: StripeRefunds,
    private readonly bounded: Stripe.RequestOptions,
  ) {}

  async create(input: RefundIntentInput, idempotencyKey: string): Promise<ProviderRefund> {
    try {
      const refund = await this.refunds.create(
        {
          payment_intent: input.intentId,
          amount: input.amountMinor,
          reason: 'requested_by_customer',
          metadata: { order_id: input.orderId, requested_by: input.requestedBy },
        },
        { idempotencyKey, ...this.bounded },
      );
      return toProviderRefund(refund);
    } catch (error) {
      return this.afterRefusal(input, error);
    }
  }

  async retrieve(refundId: string): Promise<ProviderRefund> {
    try {
      return toProviderRefund(await this.refunds.retrieve(refundId, undefined, this.bounded));
    } catch (error) {
      throw new PaymentGatewayError(`Stripe refund retrieve failed (${describe(error)})`, error);
    }
  }

  private async afterRefusal(input: RefundIntentInput, error: unknown): Promise<ProviderRefund> {
    // Before the final refusals: a charge refunded in full must be adopted, never settled as failed.
    if (hasStripeCode(error, 'charge_already_refunded')) {
      return this.adoptRefundedCharge(input, error);
    }
    const refusal = finalRefusalOf(error);
    if (refusal) {
      return {
        refundId: null,
        intentId: input.intentId,
        metadataOrderId: null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: 'failed',
        failureReason: refusal,
      };
    }
    // A 5xx may have applied; an in-flight twin may still apply. Anything else (a timeout, a 429)
    // is an unknown outcome under a key that stays valid.
    if (!isStripeServerError(error) && !isStripeRequestInFlight(error)) {
      throw new PaymentGatewayError(`Stripe refund failed (${describe(error)})`, error);
    }
    const applied = findApplied(input, await this.listFor(input, error), error);
    if (applied) return toProviderRefund(applied);
    throw new PaymentGatewayError(`Stripe refund failed and refunded nothing yet (${describe(error)})`, error, {
      retryWithFreshKey: isStripeServerError(error),
    });
  }

  // Ours under a key Stripe already pruned, or someone else's from the dashboard. Either way the buyer
  // has the money back, so adopting is what keeps them from being refunded twice.
  private async adoptRefundedCharge(input: RefundIntentInput, refusal: unknown): Promise<ProviderRefund> {
    const live = (await this.listFor(input, refusal)).filter((refund) => !isFailed(refund));
    live.forEach((refund) => assertBoundTo(input, refund, refusal));
    const total = live.reduce((sum, refund) => sum + refund.amount, 0);
    if (total !== input.amountMinor || !live.every((refund) => sameCurrency(input, refund))) {
      // The refusal created nothing, and Stripe replays it under the key even after a covering refund
      // failed; a fresh key asks again, which Stripe's cap keeps from ever refunding past the charge.
      throw new PaymentGatewayError(
        `Stripe reads the charge refunded, but its refunds add up to ${total}, not ${input.amountMinor}`,
        refusal,
        { retryWithFreshKey: true },
      );
    }
    if (live.length === 1) return toProviderRefund(live[0]);
    return {
      refundId: null,
      intentId: input.intentId,
      metadataOrderId: null,
      amountMinor: total,
      currency: live[0].currency,
      status: live.every((refund) => refund.status === 'succeeded') ? 'succeeded' : 'pending',
      failureReason: null,
      coveredBy: live.map((refund) => refund.id),
    };
  }

  private async listFor(input: RefundIntentInput, cause: unknown): Promise<Stripe.Refund[]> {
    try {
      const page = await this.refunds.list({ payment_intent: input.intentId, limit: LIST_LIMIT }, this.bounded);
      return page.data;
    } catch (readError) {
      throw new PaymentGatewayError(
        `Stripe refund failed (${describe(cause)}) and the intent's refunds could not be read (${describe(readError)})`,
        cause,
      );
    }
  }
}

/**
 * A live refund of ours, else a live one of the same amount made elsewhere, else a failed one of ours:
 * a failed earlier attempt must never hide one that returned the money.
 */
function findApplied(input: RefundIntentInput, refunds: Stripe.Refund[], cause: unknown): Stripe.Refund | undefined {
  const matching = refunds.filter((refund) => refund.amount === input.amountMinor && sameCurrency(input, refund));
  const isOurs = (refund: Stripe.Refund) => metadataOrderId(refund) === input.orderId;
  const live = matching.filter((refund) => !isFailed(refund));
  const liveOurs = live.find(isOurs);
  if (liveOurs) return liveOurs;
  live.forEach((refund) => assertBoundTo(input, refund, cause));
  return live[0] ?? matching.find(isOurs);
}

/**
 * The refusal code no retry can turn into a refund. Stripe documents its codes but not which one an
 * amount past the refundable remainder carries, so any refusal of the amount itself counts as final.
 */
function finalRefusalOf(error: unknown): string | null {
  if (!(error instanceof Stripe.errors.StripeError)) return null;
  if (error.code && FINAL_REFUSALS.includes(error.code)) return error.code;
  if (error instanceof Stripe.errors.StripeInvalidRequestError && error.param === 'amount') {
    return error.code ?? 'amount_rejected';
  }
  return null;
}

function assertBoundTo(input: RefundIntentInput, refund: Stripe.Refund, cause: unknown): void {
  const named = metadataOrderId(refund);
  if (named !== null && named !== input.orderId) {
    throw new PaymentGatewayError(
      `refund metadata names another order (${refund.id} on ${input.intentId} names ${named}, not ${input.orderId})`,
      cause,
    );
  }
}

function toProviderRefund(refund: Stripe.Refund): ProviderRefund {
  const intent = refund.payment_intent;
  return {
    refundId: refund.id,
    intentId: typeof intent === 'string' ? intent : (intent?.id ?? null),
    metadataOrderId: metadataOrderId(refund),
    amountMinor: refund.amount,
    currency: refund.currency,
    // Unknown or missing reads as still in flight: never as settled either way.
    status: refund.status && KNOWN_STATUSES.has(refund.status) ? (refund.status as ReportedRefundStatus) : 'pending',
    failureReason: refund.failure_reason ?? null,
  };
}

function metadataOrderId(refund: Stripe.Refund): string | null {
  const named = refund.metadata?.order_id;
  return typeof named === 'string' && named !== '' ? named : null;
}

function isFailed(refund: Stripe.Refund): boolean {
  return refund.status === 'failed' || refund.status === 'canceled';
}

function sameCurrency(input: RefundIntentInput, refund: Stripe.Refund): boolean {
  return refund.currency.toUpperCase() === input.currency.toUpperCase();
}

function describe(error: unknown): string {
  return error instanceof Stripe.errors.StripeError ? `${error.type}: ${error.message}` : String(error);
}
