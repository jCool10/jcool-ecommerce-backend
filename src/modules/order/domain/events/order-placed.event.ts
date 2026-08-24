/**
 * Emitted when an order moves DRAFT → PENDING. Predates the `DomainEvent` interface, hence
 * `orderId`/`placedAt` rather than `aggregateId`/`occurredAt`.
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
