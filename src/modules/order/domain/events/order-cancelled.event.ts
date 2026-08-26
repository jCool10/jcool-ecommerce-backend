import type { DomainEvent } from '@shared/kernel';

/** Same stock effect as FAILED/EXPIRED, kept distinct: a cancellation is a decision, not a payment result. */
export class OrderCancelledEvent implements DomainEvent {
  readonly eventName = 'order.cancelled';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
