import { assertNonEmpty, DomainError, Money } from '@jcool/kernel';
import { MAX_QUANTITY_PER_ORDER_LINE } from '../order.constants';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { assertTransition, isTerminal } from './order-state-machine';
import { OrderPlacedEvent } from './events/order-placed.event';
import { OrderPaidEvent } from './events/order-paid.event';
import { OrderFailedEvent } from './events/order-failed.event';
import { OrderExpiredEvent } from './events/order-expired.event';
import { OrderCancelledEvent } from './events/order-cancelled.event';

export type SettleOutcome =
  typeof OrderStatus.PAID | typeof OrderStatus.FAILED | typeof OrderStatus.EXPIRED | typeof OrderStatus.CANCELLED;

export type OrderFinalizedEvent = OrderPaidEvent | OrderFailedEvent | OrderExpiredEvent | OrderCancelledEvent;

interface Settlement {
  finalizedAt: Date;
  finalizeReason: string | null;
  paymentRef: string | null;
}

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
    // Stamped once, when the order reaches a terminal status; null before that.
    public readonly finalizedAt: Date | null,
    public readonly finalizeReason: string | null,
    public readonly paymentRef: string | null,
  ) {}

  static create(userId: string, currency: string, items: OrderItem[]): Order {
    assertNonEmpty(userId, 'Order.userId');
    if (items.length === 0) {
      throw new DomainError('Order must have at least one item');
    }
    // Checked here, not in OrderItem.of, which also rehydrates orders placed before the cap existed.
    const oversized = items.find((item) => item.quantity > MAX_QUANTITY_PER_ORDER_LINE);
    if (oversized) {
      throw new DomainError(
        `Order line quantity must not exceed ${MAX_QUANTITY_PER_ORDER_LINE} per SKU: ${oversized.skuId}`,
      );
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

  isTerminal(): boolean {
    return isTerminal(this.status);
  }

  /** `placedAt` is stamped here: the payment deadline runs from it, before the Try has answered. */
  reserve(now: Date): Order {
    return this.moveTo(OrderStatus.RESERVING, { placedAt: now });
  }

  confirmPlaced(): Order {
    return this.moveTo(OrderStatus.PENDING);
  }

  reject(reason: string, now: Date): Order {
    return this.moveTo(OrderStatus.REJECTED, { finalizedAt: now, finalizeReason: reason, paymentRef: null });
  }

  confirming(): Order {
    return this.moveTo(OrderStatus.CONFIRMING);
  }

  /** Idempotency is the caller's job (row lock + saga version) before it ever gets here. */
  settle(outcome: SettleOutcome, meta: { now: Date; reason?: string | null; paymentRef?: string | null }): Order {
    return this.moveTo(outcome, {
      finalizedAt: meta.now,
      finalizeReason: meta.reason ?? null,
      paymentRef: meta.paymentRef ?? null,
    });
  }

  toPlacedEvent(): OrderPlacedEvent {
    if (this.id === null || this.placedAt === null || this.status !== OrderStatus.PENDING) {
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

  private moveTo(to: OrderStatus, changes: Partial<Settlement> & { placedAt?: Date } = {}): Order {
    assertTransition(this.status, to);
    return new Order(
      this.id,
      this.userId,
      to,
      this.currency,
      this.items,
      this.totalAmountMinor,
      changes.placedAt ?? this.placedAt,
      changes.finalizedAt ?? this.finalizedAt,
      changes.finalizeReason !== undefined ? changes.finalizeReason : this.finalizeReason,
      changes.paymentRef !== undefined ? changes.paymentRef : this.paymentRef,
    );
  }
}
