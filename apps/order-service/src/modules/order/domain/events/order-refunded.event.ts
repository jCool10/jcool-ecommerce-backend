import type { DomainEvent } from '@jcool/kernel';

/** `requestedBy` is the admin whose refund ran; a second admin who asked meanwhile is not recorded. */
export class OrderRefundedEvent implements DomainEvent {
  readonly eventName = 'order.refunded';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly totalAmountMinor: number,
    readonly currency: string,
    readonly paymentRef: string | null,
    readonly requestedBy: string,
    readonly reason: string,
    readonly occurredAt: Date,
  ) {}
}
