import { Entity } from './entity';
import type { DomainEvent } from './domain-event';

/**
 * An aggregate root: an entity that also records domain events as its invariants
 * change. `pullDomainEvents` returns the buffered events and clears them in one
 * step (idempotent flush) so the caller — the persistence boundary — drains them
 * exactly once after a successful save. A second pull returns an empty array.
 */
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
