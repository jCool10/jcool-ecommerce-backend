import { Entity } from './entity';
import type { DomainEvent } from './domain-event';

/** `pullDomainEvents` empties the buffer, so the persistence boundary must drain it exactly once,
 * after a successful save. */
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
