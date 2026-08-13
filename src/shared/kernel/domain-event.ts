/** A fact that happened inside a bounded context, raised by an aggregate; concrete events live in `modules/<ctx>/domain/events/`, implement this interface, and are collected via `AggregateRoot.addDomainEvent`. */
export interface DomainEvent {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}
