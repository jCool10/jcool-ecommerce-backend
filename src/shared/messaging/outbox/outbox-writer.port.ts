import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// The write half of the transactional outbox. Pure (no drizzle-orm/schema import) so an
// application layer can emit an event without depending on infrastructure.

export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');

export interface OutboxRecord {
  /** The context that owns the event's aggregate, e.g. 'Order'. */
  aggregateType: string;
  aggregateId: string;
  /** The event's name, e.g. 'order.placed' — what a consumer dispatches on. */
  eventType: string;
  /** Stable data only: ids, minor-unit money, ISO timestamps. Never a live entity. */
  payload: Record<string, unknown>;
}

export interface OutboxWriterPort {
  /**
   * Append one event using the CALLER'S transaction — never its own. That is the whole point:
   * the business change and its event commit or roll back as a single write, so there is no
   * window in which one exists without the other (the dual-write problem).
   */
  append(tx: DrizzleTx, record: OutboxRecord): Promise<void>;
}
