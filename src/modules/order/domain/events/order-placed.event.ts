/**
 * Domain event emitted (conceptually) when an order moves DRAFT → PENDING.
 *
 * EXTENSION — BF#4 Outbox/Saga (Weeks 8-9): DECLARED, NOT PUBLISHED in Week 3.
 * Because place-order already runs in a transaction, wiring this later is
 * additive: append the event to an `outbox` table inside that same transaction
 * (one insert), and a separate relay/saga module publishes it. Nothing here
 * produces behavior yet — it only fixes the event's shape so the seam is real.
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
