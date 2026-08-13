import { Entity } from './entity';
import type { DomainEvent } from './domain-event';

/** An entity that buffers domain events as its invariants change; `pullDomainEvents` returns and clears them in one idempotent flush so the persistence boundary drains them exactly once after a successful save. */
export abstract class AggregateRoot<TId> extends Entity<TId> {
  private _domainEvents: DomainEvent[] = [];

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }
}
