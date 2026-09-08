import { assertNonEmpty, DomainError, Money } from '@shared/kernel';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { assertTransition, isTerminal } from './order-state-machine';
import { OrderPlacedEvent } from './events/order-placed.event';
import { OrderPaidEvent } from './events/order-paid.event';
import { OrderFailedEvent } from './events/order-failed.event';
import { OrderExpiredEvent } from './events/order-expired.event';
import { OrderCancelledEvent } from './events/order-cancelled.event';

export type FinalizeOutcome =
  | typeof OrderStatus.PAID
  | typeof OrderStatus.FAILED
  | typeof OrderStatus.EXPIRED
  | typeof OrderStatus.CANCELLED;

export type OrderFinalizedEvent = OrderPaidEvent | OrderFailedEvent | OrderExpiredEvent | OrderCancelledEvent;

/**
 * The transactional source of truth, and pure: no framework or DB imports. The total is computed
 * once from the snapshot lines at creation, then persisted and read back — never recomputed against
 * a live price. `id` is null until the DB assigns one on insert, and a string once rehydrated.
 */
export class Order {
  private constructor(
    public readonly id: string | null,
    public readonly userId: string,
    public readonly status: OrderStatus,
    public readonly currency: string,
    public readonly items: readonly OrderItem[],
    public readonly totalAmountMinor: number,
    public readonly placedAt: Date | null,
    // Stamped once, when the order settles; null while DRAFT/PENDING.
    public readonly finalizedAt: Date | null,
    public readonly finalizeReason: string | null,
    public readonly paymentRef: string | null,
  ) {}

  static create(userId: string, currency: string, items: OrderItem[]): Order {
    assertNonEmpty(userId, 'Order.userId');
    if (items.length === 0) {
      throw new DomainError('Order must have at least one item');
    }
    // Money normalizes/validates the currency code and sums exactly (integer minor units).
    const normalizedCurrency = Money.zero(currency).currency;
    const total = items.reduce(
      (sum, item) => sum.add(item.lineTotal(normalizedCurrency)),
      Money.zero(normalizedCurrency),
    );
    return new Order(
      null,
      userId,
      OrderStatus.DRAFT,
      normalizedCurrency,
      items,
      total.amountMinor,
      null,
      null,
      null,
      null,
    );
  }

  /** Repository use only — no invariant is re-checked here. */
  static rehydrate(props: {
    id: string;
    userId: string;
    status: OrderStatus;
    currency: string;
    items: OrderItem[];
    totalAmountMinor: number;
    placedAt: Date | null;
    finalizedAt?: Date | null;
    finalizeReason?: string | null;
    paymentRef?: string | null;
  }): Order {
    return new Order(
      props.id,
      props.userId,
      props.status,
      props.currency,
      props.items,
      props.totalAmountMinor,
      props.placedAt,
      props.finalizedAt ?? null,
      props.finalizeReason ?? null,
      props.paymentRef ?? null,
    );
  }

  total(): Money {
    return Money.of(this.totalAmountMinor, this.currency);
  }

  /** Throws `OrderTransitionError` from any non-DRAFT state; the use case maps that to a 409. */
  place(now: Date): Order {
    assertTransition(this.status, OrderStatus.PENDING);
    return new Order(
      this.id,
      this.userId,
      OrderStatus.PENDING,
      this.currency,
      this.items,
      this.totalAmountMinor,
      now,
      null,
      null,
      null,
    );
  }

  isTerminal(): boolean {
    return isTerminal(this.status);
  }

  /** Idempotency is the use case's job (terminal check + row lock) before it ever gets here. */
  finalize(outcome: FinalizeOutcome, meta: { now: Date; reason?: string | null; paymentRef?: string | null }): Order {
    assertTransition(this.status, outcome);
    return new Order(
      this.id,
      this.userId,
      outcome,
      this.currency,
      this.items,
      this.totalAmountMinor,
      this.placedAt,
      meta.now,
      meta.reason ?? null,
      meta.paymentRef ?? null,
    );
  }

  toPlacedEvent(): OrderPlacedEvent {
    if (this.id === null || this.placedAt === null) {
      throw new DomainError('Only a placed order can produce an OrderPlacedEvent');
    }
    return new OrderPlacedEvent(this.id, this.userId, this.totalAmountMinor, this.currency, this.placedAt);
  }

  toFinalizedEvent(): OrderFinalizedEvent {
    if (this.id === null || this.finalizedAt === null) {
      throw new DomainError('Only a finalized order can produce a finalization event');
    }
    switch (this.status) {
      case OrderStatus.PAID:
        return new OrderPaidEvent(
          this.id,
          this.userId,
          this.totalAmountMinor,
          this.currency,
          this.paymentRef,
          this.finalizedAt,
        );
      case OrderStatus.FAILED:
        return new OrderFailedEvent(this.id, this.userId, this.finalizeReason, this.finalizedAt);
      case OrderStatus.EXPIRED:
        return new OrderExpiredEvent(this.id, this.userId, this.finalizeReason, this.finalizedAt);
      case OrderStatus.CANCELLED:
        return new OrderCancelledEvent(this.id, this.userId, this.finalizeReason, this.finalizedAt);
      default:
        throw new DomainError(`Order in status ${this.status} has no finalization event`);
    }
  }
}
