export interface DomainEvent {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}
