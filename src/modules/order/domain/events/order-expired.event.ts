import type { DomainEvent } from '@shared/kernel';

/**
 * Raised when an unpaid order is finalized PENDING → EXPIRED (expiry sweep).
 *
 * Declared seam, NOT published yet: a later outbox relay appends it inside the finalize
 * transaction, and an Inventory subscriber releases the held reservation off it. Same
 * release effect as FAILED, kept a distinct event so consumers can tell a timeout from a
 * gateway rejection. `aggregateId` is the order id.
 */
export class OrderExpiredEvent implements DomainEvent {
  readonly eventName = 'order.expired';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
