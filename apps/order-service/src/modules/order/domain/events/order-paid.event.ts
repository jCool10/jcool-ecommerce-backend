import type { DomainEvent } from '@jcool/kernel';

/** `paymentRef` is null only when the change that paid the order named no payment. */
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
