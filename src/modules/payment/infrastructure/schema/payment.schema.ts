import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Infrastructure only, never imported by domain. No cross-context FK: order_id → orders stays an
// app-layer boundary (Payment reads the order through a port, never its table), matching
// inventory.reservations.order_id.

export const paymentStatus = pgEnum('payment_status', ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED']);
export const webhookStatus = pgEnum('webhook_status', ['RECEIVED', 'PROCESSED', 'SKIPPED', 'FAILED']);

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// amount_minor is snapshotted from the order total at session creation; the payment never re-reads a
// live price.
export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id').notNull(),
    // Text, not an enum: a row records which gateway actually took the money, and old rows must stay
    // readable after the app stops offering that gateway — which a pgEnum could not do without
    // rewriting history.
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id').notNull(),
    providerIntentId: text('provider_intent_id'), // filled from the webhook / reconcile later
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    ...stamps,
  },
  (t) => [
    index('idx_payments_order').on(t.orderId),
    // At most one live payment per order — the DB backstop for "never double-charge". Partial so a
    // FAILED/EXPIRED attempt never blocks a legitimate retry. The app pre-checks too; this closes the
    // concurrent-double-submit race the check cannot.
    uniqueIndex('uq_payments_one_active_per_order')
      .on(t.orderId)
      .where(sql`status in ('PENDING', 'SUCCEEDED')`),
  ],
);

// Append-only. The UNIQUE(provider, provider_event_id) is the idempotency backstop: a duplicate
// delivery loses the INSERT race instead of double-applying.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: webhookStatus('status').notNull().default('RECEIVED'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_webhook_provider_event').on(t.provider, t.providerEventId),
    // The retention sweep's predicate. The unique index above is on the identity pair, which says
    // nothing about age, so without this the sweep would scan every event ever received.
    index('idx_webhook_events_received').on(t.receivedAt),
  ],
);
