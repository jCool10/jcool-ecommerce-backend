import type { DrizzleSchema, DrizzleTxOf } from '@jcool/platform/database';

// Kept pure (types only, no drizzle-orm or schema at runtime) so an application layer can emit an
// event without depending on infrastructure.

export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');

/** All the writer needs of the caller's transaction; every service's Drizzle tx has it. */
export type OutboxTx = Pick<DrizzleTxOf<DrizzleSchema>, 'insert'>;

export interface OutboxRecord {
  aggregateType: string;
  aggregateId: string;
  /** The event's name, e.g. 'order.placed' — what a consumer dispatches on. */
  eventType: string;
  /** Stable data only: ids, minor-unit money, ISO timestamps. Never a live entity. */
  payload: Record<string, unknown>;
}

export interface OutboxWriterPort<Tx = OutboxTx> {
  /**
   * Appends using the CALLER'S transaction, never its own: the business change and its event commit
   * or roll back as one write, so there is no window in which one exists without the other.
   * Pass `id` when it was minted before the transaction opened. Throws for an event type with no
   * route, which rolls the business change back with it.
   */
  append(tx: Tx, record: OutboxRecord, options?: { id?: string }): Promise<void>;
}
