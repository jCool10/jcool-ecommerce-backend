import { assertNonEmpty, DomainError, Money } from '@shared/kernel';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { assertTransition, isTerminal } from './order-state-machine';
import { OrderPlacedEvent } from './events/order-placed.event';
import { OrderPaidEvent } from './events/order-paid.event';
import { OrderFailedEvent } from './events/order-failed.event';
import { OrderExpiredEvent } from './events/order-expired.event';

/** The terminal outcomes finalization can drive a PENDING order to. */
export type FinalizeOutcome = typeof OrderStatus.PAID | typeof OrderStatus.FAILED | typeof OrderStatus.EXPIRED;

/** The domain event a finalized order represents (declared seam; nothing publishes it yet). */
export type OrderFinalizedEvent = OrderPaidEvent | OrderFailedEvent | OrderExpiredEvent;

/**
 * Order aggregate — the transactional source of truth. Pure: no framework/DB
 * imports. Holds price-snapshot lines, the frozen total, and a status. The total
 * is computed once from the lines at creation and then persisted/read back — never
 * recomputed against a live price. State changes go through the state machine
 * (`place()` asserts DRAFT → PENDING) so the transition rule stays in one place.
 *
 * `id` is null before persistence (created from a cart, id assigned by the DB) and
 * a string once rehydrated from a row.
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
    // Set once, when the order enters a terminal state (PAID/FAILED/EXPIRED); null while PENDING/DRAFT.
    public readonly finalizedAt: Date | null,
    public readonly finalizeReason: string | null,
    // Gateway transaction id captured at finalize, for reconciliation; null unless a paid webhook carried one.
    public readonly paymentRef: string | null,
  ) {}

  /** Build a new DRAFT order from snapshotted lines (id assigned later, on insert). */
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

  /** Reconstruct an order from persisted state (repository use only). */
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

  /** The frozen snapshot total (minor units) as Money — the persisted source of truth. */
  total(): Money {
    return Money.of(this.totalAmountMinor, this.currency);
  }

  /**
   * Place the order: asserts the DRAFT → PENDING transition, then returns a placed
   * copy (immutable). Throws `OrderTransitionError` from any non-DRAFT state — the
   * use-case maps that to a 409. Persistence performs the atomic status change.
   */
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

  /** True once the order is settled (PAID/FAILED/EXPIRED/CANCELLED) and must never regress. */
  isTerminal(): boolean {
    return isTerminal(this.status);
  }

  /**
   * Finalize the order to a terminal outcome (PENDING → PAID/FAILED/EXPIRED), stamping when and why.
   * Asserts the transition (throws `OrderTransitionError` from any non-PENDING state) and returns a
   * new immutable copy — the use-case guards idempotency (terminal check + row lock) before calling.
   */
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

  /**
   * The domain event this (placed) order represents. Declared for a future outbox/publish path
   * (checkout would append it in the placement transaction); nothing publishes it yet. Only a
   * persisted, placed order can produce one.
   */
  toPlacedEvent(): OrderPlacedEvent {
    if (this.id === null || this.placedAt === null) {
      throw new DomainError('Only a placed order can produce an OrderPlacedEvent');
    }
    return new OrderPlacedEvent(this.id, this.userId, this.totalAmountMinor, this.currency, this.placedAt);
  }

  /**
   * The domain event a just-finalized order represents. Declared seam: a later outbox relay appends
   * it inside the finalize transaction, a subscriber commits/releases stock off it. Only a persisted,
   * finalized order can produce one.
   */
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
      default:
        throw new DomainError(`Order in status ${this.status} has no finalization event`);
    }
  }
}
