import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Transactional outbox — the one table that is deliberately NOT owned by a bounded context
// (ADR 0019): it carries events from any context, written inside that context's own transaction.
// Same conventions as every other table (UUID v7 ids, tz stamps, no cross-context FK).

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const outbox = pgTable(
  'outbox',
  {
    id: id(),
    // 'Order' today; 'Payment' and others as they start emitting.
    aggregateType: text('aggregate_type').notNull(),
    // No FK — the outbox outlives and out-scopes any single context's tables.
    aggregateId: uuid('aggregate_id').notNull(),
    // The event's own name ('order.placed', 'order.paid', ...); the consumer dispatches on it.
    eventType: text('event_type').notNull(),
    // A stable snapshot of the event: ids, minor-unit money, ISO timestamps. Never a live entity,
    // so a replay a week later still means what it meant at write time.
    payload: jsonb('payload').notNull(),
    // W3C traceparent captured at insert, so a consumer can continue the producer's trace across
    // the queue boundary (auto-instrumentation cannot follow an async hop).
    traceparent: text('traceparent'),
    // Publish attempts by the relay; a permanently failing row is visible without reading logs.
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
    // Until a relay exists nothing is ever marked published, so today those are the same set and the
    // table is append-only on the hottest write path — retention arrives with the relay.
    index('idx_outbox_unpublished')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
  ],
);
