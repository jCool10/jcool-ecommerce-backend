import type { DomainEvent } from '@shared/kernel';

/**
 * Raised when an order is finalized PENDING → PAID (webhook success or reconciliation).
 *
 * Declared seam, NOT published yet: a later outbox relay appends it inside the finalize
 * transaction (one insert), and an Inventory subscriber commits the reservation off it.
 * `aggregateId` is the order id; `paymentRef` is the gateway transaction id when the
 * outcome carried one (nullable — reconciliation may confirm PAID without echoing it).
 */
export class OrderPaidEvent implements DomainEvent {
  readonly eventName = 'order.paid';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly totalAmountMinor: number,
    readonly currency: string,
    readonly paymentRef: string | null,
    readonly occurredAt: Date,
  ) {}
}
