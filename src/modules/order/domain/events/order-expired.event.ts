import type { DomainEvent } from '@shared/kernel';

/**
 * Appended to the outbox by finalize on the expiry sweep; nothing publishes it from there yet. Same
 * stock effect as FAILED, kept distinct so a consumer can tell a timeout from a gateway rejection.
 */
export class OrderExpiredEvent implements DomainEvent {
  readonly eventName = 'order.expired';

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly reason: string | null,
    readonly occurredAt: Date,
  ) {}
}
