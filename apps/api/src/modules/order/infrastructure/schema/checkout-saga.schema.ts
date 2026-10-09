import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';
import { orders } from './order.schema';

export const checkoutSagaStep = pgEnum('checkout_saga_step', [
  'RESERVING',
  'AWAITING_AUTH',
  'COMMITTING_STOCK',
  'CAPTURING',
  'COMPLETED',
  'COMPENSATING',
  'COMPENSATED',
]);

export const checkoutSagas = pgTable(
  'checkout_sagas',
  {
    orderId: snowflakeId('order_id')
      .primaryKey()
      .references(() => orders.id, { onDelete: 'cascade' }),
    step: checkoutSagaStep('step').notNull(),
    // A set: every advance tries all of them and drops the ones that finished.
    pendingCompensations: text('pending_compensations')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    // Equals `lease_until` while leased, so a dead owner's saga falls due exactly when its lease ends.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastError: text('last_error'),
    // Bumped by every write; renew and apply compare-and-set on the value their claim returned.
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    routableIdCheck('ck_checkout_sagas_order_id_routable', t.orderId),
    index('idx_checkout_sagas_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.step} NOT IN ('COMPLETED', 'COMPENSATED')`),
  ],
);
