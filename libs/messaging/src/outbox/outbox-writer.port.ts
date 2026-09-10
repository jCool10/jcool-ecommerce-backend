import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// Kept pure (no drizzle-orm/schema import) so an application layer can emit an event without
// depending on infrastructure.

export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');

export interface OutboxRecord {
  aggregateType: string;
  aggregateId: string;
  /** The event's name, e.g. 'order.placed' — what a consumer dispatches on. */
  eventType: string;
  /** Stable data only: ids, minor-unit money, ISO timestamps. Never a live entity. */
  payload: Record<string, unknown>;
}

export interface OutboxWriterPort {
  /**
   * Appends using the CALLER'S transaction, never its own: the business change and its event commit
   * or roll back as one write, so there is no window in which one exists without the other.
   */
  append(tx: DrizzleTx, record: OutboxRecord): Promise<void>;
}
