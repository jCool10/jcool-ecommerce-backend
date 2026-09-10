import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { DomainEventJob, PostCommitEffect } from './domain-event.job';

/**
 * The dispatch table maps an event name onto the effect that applies it, and every effect this
 * repository has belongs to a bounded context — so the table itself is application wiring, not
 * transport. The relay, the processor and the dead-letter router all live here, in the transport
 * package, and none of them may reach a context to build it.
 *
 * Two tokens rather than one because the two consumers want different halves and injecting the
 * whole thing to call `label()` reads as if the relay dispatched something (it does not):
 *
 *   {@link DOMAIN_EVENT_DISPATCHER} — applies an event, inside the consumer's transaction.
 *   {@link EVENT_LABEL_REGISTRY}    — folds a free-text `event_type` into the bounded set of names
 *                                     the dispatch table knows, so a metric cannot mint a time
 *                                     series per value seen on the wire.
 */
export const DOMAIN_EVENT_DISPATCHER = Symbol('DOMAIN_EVENT_DISPATCHER');

export const EVENT_LABEL_REGISTRY = Symbol('EVENT_LABEL_REGISTRY');

/**
 * An effect runs inside the consumer's transaction — the same one holding the inbox claim — so a
 * handler that fails un-marks the event and the redelivery runs it for real. Work the transaction
 * cannot hold is returned instead; see {@link PostCommitEffect}.
 */
export type DomainEventHandler = (job: DomainEventJob, tx: DrizzleTx) => Promise<PostCommitEffect | void>;

export interface DomainEventDispatcherPort {
  dispatch(job: DomainEventJob, tx: DrizzleTx): Promise<PostCommitEffect | void>;
}

export interface EventLabelRegistry {
  /** The event name if the dispatch table knows it, one catch-all constant otherwise. */
  label(eventType: string): string;
}
