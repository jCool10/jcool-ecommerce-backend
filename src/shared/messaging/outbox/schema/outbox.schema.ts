import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Deliberately NOT owned by a bounded context: it carries events from any context, written inside
// that context's own transaction.

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const outbox = pgTable(
  'outbox',
  {
    id: id(),
    aggregateType: text('aggregate_type').notNull(),
    // No FK — the outbox outlives and out-scopes any single context's tables.
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // W3C traceparent captured at insert, so a consumer can continue the producer's trace across
    // the queue boundary (auto-instrumentation cannot follow an async hop).
    traceparent: text('traceparent'),
    // Persisted so a permanently failing row is visible without reading logs.
    attempts: integer('attempts').notNull().default(0),
    // `now()` is TRANSACTION start time, not statement time: two events from one transaction share a
    // timestamp, and a slow transaction can commit a row whose `created_at` predates rows already
    // committed. Safe for a relay that polls `published_at IS NULL`; a watermark relay would skip
    // rows. Order by `(created_at, id)` — the UUIDv7 id breaks ties monotonically.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL = not yet published. The relay's entire work queue.
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    // Partial so the index tracks the unpublished backlog rather than every event ever emitted.
    index('idx_outbox_unpublished')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
    // The exact complement of the index above: the sweep reads published rows, the relay unpublished
    // ones, and neither index can serve the other's predicate.
    index('idx_outbox_published')
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} is not null`),
  ],
);
