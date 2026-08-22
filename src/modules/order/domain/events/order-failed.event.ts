import type { DomainEvent } from '@shared/kernel';

/** Produced by finalize on a failed payment, but nothing publishes it yet. */
export class OrderFailedEvent implements DomainEvent {
  readonly eventName = 'order.failed';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
