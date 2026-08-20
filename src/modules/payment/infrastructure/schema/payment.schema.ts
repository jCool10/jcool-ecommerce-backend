import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Payment schema (payments + webhook_events) — the "never double-charge" invariant.
// Infrastructure only, never imported by domain. Same conventions as the other
// contexts (UUID v7 ids, tz stamps, integer minor-unit money). No cross-context FK:
// order_id → orders stays an app-layer boundary (Payment reads the order through a
// port, never its table), matching inventory.reservations.order_id.
//
// payment_status is the payment side's own machine, deliberately separate from
// order_status so a webhook touches only the payment and never finalizes the order.

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

// One payment attempt for an order. amount_minor is snapshotted from the order total at
// session creation; the payment never re-reads a live price.
export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id').notNull(),
    provider: text('provider').notNull(), // 'stripe' | 'sepay' | ...
    providerSessionId: text('provider_session_id').notNull(), // handle returned when the gateway session is created
    providerIntentId: text('provider_intent_id'), // filled from the webhook / reconcile later
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    ...stamps,
  },
  (t) => [
    index('idx_payments_order').on(t.orderId),
    // At most one live payment per order — the DB backstop for "never double-charge", mirroring
    // webhook_events' unique index. Partial so a FAILED/EXPIRED attempt never blocks a legitimate
    // retry. The app pre-checks too; this closes the concurrent-double-submit race the check can't.
    uniqueIndex('uq_payments_one_active_per_order')
      .on(t.orderId)
      .where(sql`status in ('PENDING', 'SUCCEEDED')`),
  ],
);

// Append-only log of every webhook the gateway delivers. The UNIQUE(provider,
// provider_event_id) is the idempotency backstop — the DB is the final source of truth,
// so a duplicate delivery loses the INSERT race instead of double-applying.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(), // gateway event id (e.g. Stripe's evt_...)
    type: text('type').notNull(), // e.g. 'payment_intent.succeeded'
    payload: jsonb('payload').notNull(), // the verified body, kept for audit / reconcile
    status: webhookStatus('status').notNull().default('RECEIVED'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('uq_webhook_provider_event').on(t.provider, t.providerEventId)],
);
