import type { DomainEvent } from '@shared/kernel';

export class OrderFailedEvent implements DomainEvent {
  readonly eventName = 'order.failed';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
