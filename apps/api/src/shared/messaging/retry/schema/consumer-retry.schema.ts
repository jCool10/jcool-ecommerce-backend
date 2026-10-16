import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { DeadLetterReason } from '@jcool/metrics-port';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';
import type { DomainEventJob } from '../../queue/domain-event.job';

export const consumerRetryStatus = pgEnum('consumer_retry_status', ['pending', 'dead']);

// A failed delivery waiting for its next attempt, or a dead letter. Keyed on the message rather than
// a minted id on purpose: parking must not depend on the id-service, which may be the very thing the
// handler just failed on.
export const consumerRetries = pgTable(
  'consumer_retries',
  {
    consumer: text('consumer').notNull(),
    messageId: snowflakeId('message_id').notNull(),
    eventType: text('event_type').notNull(),
    envelope: jsonb('envelope').$type<DomainEventJob>().notNull(),
    attemptsMade: integer('attempts_made').notNull(),
    // Doubles as the lease deadline while a poller holds the row.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    leaseToken: text('lease_token'),
    status: consumerRetryStatus('status').notNull(),
    deadReason: text('dead_reason').$type<DeadLetterReason>(),
    lastError: text('last_error').notNull(),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull().defaultNow(),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_consumer_retries', columns: [t.consumer, t.messageId] }),
    routableIdCheck('ck_consumer_retries_message_id_routable', t.messageId),
    index('idx_consumer_retries_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('idx_consumer_retries_dead')
      .on(t.createdAt)
      .where(sql`${t.status} = 'dead'`),
  ],
);
