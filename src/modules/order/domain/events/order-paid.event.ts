import type { DomainEvent } from '@shared/kernel';

/**
 * Appended to the outbox by finalize, in the same transaction as the status change; nothing
 * publishes it from there yet. `paymentRef` is null when the outcome carried no gateway handle —
 * the sweep can confirm PAID without echoing one.
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
