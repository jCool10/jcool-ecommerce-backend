import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// One row per event a consumer has actually applied. Like the outbox, deliberately not owned by a
// bounded context. A row may only ever be pruned once the queue can no longer redeliver the message
// it stands for, or dedup silently stops working.

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const inbox = pgTable(
  'inbox',
  {
    id: id(),
    // A consumer GROUP, not a process: every instance of one worker shares this value so they dedup
    // against each other, while a second, independent consumer of the same event gets its own row.
    consumer: text('consumer').notNull(),
    // The outbox row id, assigned once at append and carried through every redelivery. A job id
    // would not do: a retry — or a republish after retention freed the id — mints a new one.
    messageId: uuid('message_id').notNull(),
    // Denormalised so the inbox alone answers "what has this consumer applied", without a join back
    // to an outbox row that may have been archived.
    eventType: text('event_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At-least-once delivery is a fact of the transport; this index is what makes it harmless, and
    // it is held by the database rather than by application logic.
    uniqueIndex('uq_inbox_consumer_message').on(t.consumer, t.messageId),
    // The retention sweep reads by age; the unique index above is on identity and cannot serve it.
    index('idx_inbox_processed').on(t.processedAt),
  ],
);
