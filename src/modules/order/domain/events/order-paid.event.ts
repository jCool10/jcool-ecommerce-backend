import type { DomainEvent } from '@shared/kernel';

/**
 * Produced by finalize, but nothing publishes it yet. `paymentRef` is null when the outcome carried
 * no gateway handle — the sweep can confirm PAID without echoing one.
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
