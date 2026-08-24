import type { DomainEvent } from '@shared/kernel';

/** Appended to the outbox by finalize on a failed payment; nothing publishes it from there yet. */
export class OrderFailedEvent implements DomainEvent {
  readonly eventName = 'order.failed';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
