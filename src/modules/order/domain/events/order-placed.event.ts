/**
 * Emitted when an order moves DRAFT → PENDING. Checkout appends it to the outbox inside the
 * placement transaction, so it cannot exist without the order or the order without it. Nothing
 * publishes it out of the outbox yet.
 *
 * Predates the `DomainEvent` interface, hence `orderId`/`placedAt` rather than
 * `aggregateId`/`occurredAt`.
 */
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly userId: string,
    readonly totalAmountMinor: number,
    readonly currency: string,
    readonly placedAt: Date,
  ) {}
}
