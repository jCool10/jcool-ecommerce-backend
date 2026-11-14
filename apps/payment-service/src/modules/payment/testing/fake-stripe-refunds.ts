import { v7 as uuidv7 } from 'uuid';
import type { ReportedRefundStatus } from '../domain/refund-settlement';
import {
  PaymentGatewayError,
  type ProviderRefund,
  type RefundIntentInput,
} from '../application/ports/payment-gateway.port';

/**
 * How the next refund of an intent goes, as the real adapter would report it:
 * - `refund_pending`: Stripe holds it as pending until `settleRefund`.
 * - `refund_fails`: Stripe fails it at once.
 * - `refund_applied_then_500`: applied, then a 5xx; the read-back finds it.
 * - `server_error`: a 5xx stored under the key without applying it.
 * - `timeout`: applied at Stripe, but the answer never arrives.
 */
export type FakeRefundFault =
  'refund_pending' | 'refund_fails' | 'refund_applied_then_500' | 'server_error' | 'timeout';

export interface FakeRefund {
  id: string;
  intentId: string;
  amountMinor: number;
  currency: string;
  status: ReportedRefundStatus;
  failureReason: string | null;
  metadata: Record<string, string>;
}

/** What the fake knows of a captured charge. */
export interface FakeCharge {
  captured: boolean;
  amountMinor: number;
  currency: string;
}

// A refused create is replayed as the refusal; the real adapter then reads the intent's refunds again.
type StoredAnswer = { ok: ProviderRefund } | { serverError: true } | { alreadyRefunded: true };

const FAILURE_REASON = 'expired_or_canceled_card';

/**
 * Stripe's refunds for the fake gateway. It answers what the real adapter would after its own
 * read-backs and adoptions, so the caller lands in the same position: the first answer under a key is
 * replayed as stored, the way Stripe replays a stored response even after the refund has moved on.
 */
export class FakeStripeRefunds {
  private readonly refunds = new Map<string, FakeRefund>();
  private readonly answers = new Map<string, StoredAnswer>();
  private readonly faults = new Map<string, FakeRefundFault>();
  private readonly unreachable = new Set<string>();

  constructor(private readonly chargeOf: (intentId: string) => FakeCharge | undefined) {}

  fail(intentId: string, fault: FakeRefundFault): void {
    this.faults.set(intentId, fault);
  }

  /** Every refund call for the intent throws until restored, as when Stripe or its breaker is down. */
  failCalls(intentId: string): void {
    this.unreachable.add(intentId);
  }

  restoreCalls(intentId: string): void {
    this.unreachable.delete(intentId);
  }

  settle(refundId: string, status: 'succeeded' | 'failed'): void {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`fake gateway has no refund ${refundId}`);
    refund.status = status;
    refund.failureReason = status === 'failed' ? FAILURE_REASON : null;
  }

  /** Someone refunds the charge in the dashboard: no metadata, the whole amount unless told otherwise. */
  outOfBand(intentId: string, amountMinor?: number): string {
    const charge = this.requireCharge(intentId);
    return this.add({ intentId, amountMinor: amountMinor ?? charge.amountMinor, currency: charge.currency }, {}).id;
  }

  of(intentId: string): FakeRefund[] {
    return [...this.refunds.values()].filter((refund) => refund.intentId === intentId).map((refund) => ({ ...refund }));
  }

  // Thrown faults surface as rejections, like the real adapter's.
  create(input: RefundIntentInput, key: string): Promise<ProviderRefund> {
    return new Promise((resolve) => resolve(this.answer(input, key)));
  }

  retrieve(refundId: string): Promise<ProviderRefund> {
    return new Promise((resolve) => {
      const refund = this.refunds.get(refundId);
      if (!refund) throw new PaymentGatewayError(`fake gateway has no refund ${refundId}`);
      this.assertReachable(refund.intentId);
      resolve(toProvider(refund));
    });
  }

  private answer(input: RefundIntentInput, key: string): ProviderRefund {
    this.assertReachable(input.intentId);
    const stored = this.answers.get(key);
    if (stored) return this.replay(input, stored);

    const fault = this.faults.get(input.intentId);
    this.faults.delete(input.intentId);
    const charge = this.requireCharge(input.intentId);
    if (!charge.captured) throw new PaymentGatewayError(`fake gateway: intent ${input.intentId} was never captured`);
    if (this.refundedTotal(input.intentId) === charge.amountMinor) {
      this.answers.set(key, { alreadyRefunded: true });
      return this.replay(input, { alreadyRefunded: true });
    }
    switch (fault) {
      case 'server_error':
        this.answers.set(key, { serverError: true });
        return this.replay(input, { serverError: true });
      case 'refund_applied_then_500':
        this.apply(input, 'succeeded');
        this.answers.set(key, { serverError: true });
        return this.replay(input, { serverError: true });
      case 'timeout':
        this.answers.set(key, { ok: this.apply(input, 'succeeded') });
        throw new PaymentGatewayError(`fake gateway: refund with key ${key} timed out`);
      case 'refund_pending':
        return this.store(key, this.apply(input, 'pending'));
      case 'refund_fails':
        return this.store(key, this.apply(input, 'failed'));
      case undefined:
        return this.store(key, this.apply(input, 'succeeded'));
    }
  }

  private store(key: string, answer: ProviderRefund): ProviderRefund {
    this.answers.set(key, { ok: answer });
    return answer;
  }

  private replay(input: RefundIntentInput, stored: StoredAnswer): ProviderRefund {
    if ('ok' in stored) return stored.ok;
    if ('alreadyRefunded' in stored) return this.adopt(input);
    // A stored 5xx makes the real adapter read the intent's refunds back.
    const applied = findApplied(input, this.of(input.intentId));
    if (applied) return toProvider(applied);
    throw new PaymentGatewayError('fake gateway: 500 stored under this key', undefined, { retryWithFreshKey: true });
  }

  private apply(input: RefundIntentInput, status: ReportedRefundStatus): ProviderRefund {
    const charge = this.requireCharge(input.intentId);
    if (this.refundedTotal(input.intentId) + input.amountMinor > charge.amountMinor) {
      return { ...refusal(input), failureReason: 'amount_too_large' };
    }
    const refund = this.add(
      { intentId: input.intentId, amountMinor: input.amountMinor, currency: charge.currency },
      { order_id: input.orderId, requested_by: input.requestedBy },
    );
    refund.status = status;
    refund.failureReason = status === 'failed' ? FAILURE_REASON : null;
    return toProvider(refund);
  }

  // Stripe answers `charge_already_refunded`; the real adapter adopts what covers the charge.
  private adopt(input: RefundIntentInput): ProviderRefund {
    const live = this.of(input.intentId).filter(isLive);
    const named = live.find((refund) => refund.metadata.order_id && refund.metadata.order_id !== input.orderId);
    if (named) throw new PaymentGatewayError(`refund metadata names another order (${named.id})`);
    const total = live.reduce((sum, refund) => sum + refund.amountMinor, 0);
    if (total !== input.amountMinor) {
      throw new PaymentGatewayError(`fake gateway: refunds add up to ${total}`, undefined, { retryWithFreshKey: true });
    }
    if (live.length === 1) return toProvider(live[0]);
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

  private refundedTotal(intentId: string): number {
    return this.of(intentId)
      .filter(isLive)
      .reduce((sum, refund) => sum + refund.amountMinor, 0);
  }

  private add(charge: Pick<FakeRefund, 'intentId' | 'amountMinor' | 'currency'>, metadata: Record<string, string>) {
    const refund: FakeRefund = {
      id: `re_fake_${uuidv7().replace(/-/g, '')}`,
      ...charge,
      status: 'succeeded',
      failureReason: null,
      metadata,
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  private requireCharge(intentId: string): FakeCharge {
    const charge = this.chargeOf(intentId);
    if (!charge) throw new PaymentGatewayError(`fake gateway has no intent ${intentId}`);
    return charge;
  }

  private assertReachable(intentId: string): void {
    if (this.unreachable.has(intentId)) {
      throw new PaymentGatewayError(`fake gateway unreachable for refunds of ${intentId}`);
    }
  }
}

/** The real adapter's read-back order: a live refund of ours, a live one made elsewhere, a failed one of ours. */
function findApplied(input: RefundIntentInput, refunds: FakeRefund[]): FakeRefund | undefined {
  const matching = refunds.filter((refund) => refund.amountMinor === input.amountMinor);
  const isOurs = (refund: FakeRefund) => refund.metadata.order_id === input.orderId;
  const live = matching.filter(isLive);
  const liveOurs = live.find(isOurs);
  if (liveOurs) return liveOurs;
  const named = live.find((refund) => refund.metadata.order_id && !isOurs(refund));
  if (named) throw new PaymentGatewayError(`refund metadata names another order (${named.id})`);
  return live[0] ?? matching.find(isOurs);
}

function isLive(refund: FakeRefund): boolean {
  return refund.status !== 'failed' && refund.status !== 'canceled';
}

function refusal(input: RefundIntentInput): ProviderRefund {
  return {
    refundId: null,
    intentId: input.intentId,
    metadataOrderId: null,
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: 'failed',
    failureReason: null,
  };
}

function toProvider(refund: FakeRefund): ProviderRefund {
  return {
    refundId: refund.id,
    intentId: refund.intentId,
    metadataOrderId: refund.metadata.order_id ?? null,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    status: refund.status,
    failureReason: refund.failureReason,
  };
}
