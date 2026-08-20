import type { DomainEvent } from '@shared/kernel';

/**
 * Raised when an order is finalized PENDING → FAILED (webhook failure or reconciliation).
 *
 * Declared seam, NOT published yet: a later outbox relay appends it inside the finalize
 * transaction, and an Inventory subscriber releases the held reservation off it so stock
 * never stays pinned behind a failed payment. `aggregateId` is the order id.
 */
export class OrderFailedEvent implements DomainEvent {
  readonly eventName = 'order.failed';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
