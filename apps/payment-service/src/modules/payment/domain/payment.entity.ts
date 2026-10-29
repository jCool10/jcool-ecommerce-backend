import { assertNonEmpty, assertPositive, Money } from '@jcool/kernel';
import { PaymentStatus } from './payment-status';
import { assertTransition, PaymentTransitionError } from './payment-state-machine';

/**
 * Pure: no framework/DB imports. `amountMinor` is a frozen snapshot of the order total (integer minor
 * units), and `id` is null before persistence, a string once rehydrated.
 */
export class Payment {
  private constructor(
    public readonly id: string | null,
    public readonly orderId: string,
    public readonly provider: string,
    public readonly providerSessionId: string,
    public readonly providerIntentId: string | null,
    public readonly amountMinor: number,
    public readonly currency: string,
    public readonly status: PaymentStatus,
    /** Generation of the Stripe idempotency keys for capture/void; moves only when Stripe provably did not apply one. */
    public readonly stripeKeyGen: number,
  ) {}

  static create(props: {
    orderId: string;
    provider: string;
    providerSessionId: string;
    amountMinor: number;
    currency: string;
    providerIntentId?: string | null;
  }): Payment {
    assertNonEmpty(props.orderId, 'Payment.orderId');
    assertNonEmpty(props.provider, 'Payment.provider');
    assertNonEmpty(props.providerSessionId, 'Payment.providerSessionId');
    // A payment is always for a real, positive charge; Money.of allows non-positive (subtract
    // can go negative), so assert the boundary invariant explicitly here.
    assertPositive(props.amountMinor, 'Payment.amountMinor');
    // Money validates the integer amount and normalizes the currency (upper ISO-4217).
    const money = Money.of(props.amountMinor, props.currency);
    return new Payment(
      null,
      props.orderId,
      props.provider,
      props.providerSessionId,
      props.providerIntentId ?? null,
      money.amountMinor,
      money.currency,
      PaymentStatus.PENDING,
      0,
    );
  }

  /** Repository use only. */
  static rehydrate(props: {
    id: string;
    orderId: string;
    provider: string;
    providerSessionId: string;
    providerIntentId: string | null;
    amountMinor: number;
    currency: string;
    status: PaymentStatus;
    stripeKeyGen?: number;
  }): Payment {
    return new Payment(
      props.id,
      props.orderId,
      props.provider,
      props.providerSessionId,
      props.providerIntentId,
      props.amountMinor,
      props.currency,
      props.status,
      props.stripeKeyGen ?? 0,
    );
  }

  amount(): Money {
    return Money.of(this.amountMinor, this.currency);
  }

  markSucceeded(providerIntentId?: string | null): Payment {
    assertTransition(this.status, PaymentStatus.SUCCEEDED);
    return this.withStatus(PaymentStatus.SUCCEEDED, providerIntentId);
  }

  markFailed(providerIntentId?: string | null): Payment {
    assertTransition(this.status, PaymentStatus.FAILED);
    return this.withStatus(PaymentStatus.FAILED, providerIntentId);
  }

  /** Only the sweep drives this — a webhook always carries a real outcome. */
  markExpired(): Payment {
    assertTransition(this.status, PaymentStatus.EXPIRED);
    return this.withStatus(PaymentStatus.EXPIRED);
  }

  markAuthorized(providerIntentId: string): Payment {
    assertTransition(this.status, PaymentStatus.AUTHORIZED);
    return this.withStatus(PaymentStatus.AUTHORIZED, providerIntentId);
  }

  /** Narrower than `markSucceeded`: only a hold can be captured. */
  markCaptured(): Payment {
    if (this.status !== PaymentStatus.AUTHORIZED) {
      throw new PaymentTransitionError(this.status, PaymentStatus.SUCCEEDED);
    }
    return this.withStatus(PaymentStatus.SUCCEEDED);
  }

  markVoided(providerIntentId?: string | null): Payment {
    assertTransition(this.status, PaymentStatus.VOIDED);
    return this.withStatus(PaymentStatus.VOIDED, providerIntentId);
  }

  private withStatus(status: PaymentStatus, providerIntentId?: string | null): Payment {
    return new Payment(
      this.id,
      this.orderId,
      this.provider,
      this.providerSessionId,
      providerIntentId ?? this.providerIntentId,
      this.amountMinor,
      this.currency,
      status,
      this.stripeKeyGen,
    );
  }
}
