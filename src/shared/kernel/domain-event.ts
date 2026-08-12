/**
 * A fact that happened inside a bounded context, raised by an aggregate. Concrete
 * events live in `modules/<ctx>/domain/events/` and implement this interface;
 * they are collected via `AggregateRoot.addDomainEvent` and later flushed to the
 * transactional outbox (see the deferred outbox phase) in the same transaction
 * that persists the aggregate.
 */
export interface DomainEvent {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}
