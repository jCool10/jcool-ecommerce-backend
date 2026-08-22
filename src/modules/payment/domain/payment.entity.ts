import { assertNonEmpty, assertPositive, Money } from '@shared/kernel';
import { PaymentStatus } from './payment-status';
import { assertTransition } from './payment-state-machine';

/**
 * Payment aggregate — the payment side of a purchase. Pure: no framework/DB imports.
 * `amountMinor` is a frozen snapshot of the order total (integer minor units). Status
 * changes go through the state machine (`markSucceeded`/`markFailed` assert the
 * transition), so an out-of-order or terminal-state webhook is rejected in the domain,
 * not left to the DB. `id` is null before persistence, a string once rehydrated.
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
  ) {}

  /** A new PENDING payment for an order (id assigned later, on insert). */
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
    );
  }

  /** Reconstruct a payment from persisted state (repository use only). */
  static rehydrate(props: {
    id: string;
    orderId: string;
    provider: string;
    providerSessionId: string;
    providerIntentId: string | null;
    amountMinor: number;
    currency: string;
    status: PaymentStatus;
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
    );
  }

  /** The frozen amount (minor units) as Money. */
  amount(): Money {
    return Money.of(this.amountMinor, this.currency);
  }

  /** PENDING → SUCCEEDED; throws `PaymentTransitionError` from any other state. */
  markSucceeded(providerIntentId?: string | null): Payment {
    assertTransition(this.status, PaymentStatus.SUCCEEDED);
    return this.withStatus(PaymentStatus.SUCCEEDED, providerIntentId);
  }

  /** PENDING → FAILED; throws `PaymentTransitionError` from any other state. */
  markFailed(providerIntentId?: string | null): Payment {
    assertTransition(this.status, PaymentStatus.FAILED);
    return this.withStatus(PaymentStatus.FAILED, providerIntentId);
  }

  /** Only the sweep drives this — a webhook always carries a real outcome. */
  markExpired(): Payment {
    assertTransition(this.status, PaymentStatus.EXPIRED);
    return this.withStatus(PaymentStatus.EXPIRED);
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
    );
  }
}
