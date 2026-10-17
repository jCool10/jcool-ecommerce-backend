import type { DomainEventJob } from '../queue/domain-event.job';

export const DOMAIN_EVENT_PUBLISHER = Symbol('DOMAIN_EVENT_PUBLISHER');

export interface OutboundEvent {
  rowId: string;
  eventType: string;
  aggregateId: string;
  envelope: DomainEventJob;
}

export interface PublishOutcome {
  rowId: string;
  ok: boolean;
  error?: Error;
  /** Never handed to the broker this tick; the relay leaves the row exactly as it was. */
  skipped?: boolean;
}

/**
 * The relay calls this once per tick, inside the transaction that holds the batch's row locks, so an
 * adapter must bound how long it waits on its broker. One outcome per event, in input order.
 */
export interface DomainEventPublisher {
  /** False makes the relay skip the tick without opening a transaction. */
  ready(): boolean;
  publish(events: OutboundEvent[]): Promise<PublishOutcome[]>;
}
