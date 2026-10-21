import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from '@jcool/platform/database';

// Infrastructure only, never imported by domain. No cross-context FK: order_id → orders stays an
// app-layer boundary (Payment reads the order through a port, never its table), matching
// inventory.reservations.order_id.

export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'AUTHORIZED',
  'VOIDED',
]);
export const webhookStatus = pgEnum('webhook_status', ['RECEIVED', 'PROCESSED', 'SKIPPED', 'FAILED']);
export const paymentOrderStatus = pgEnum('payment_order_status', [
  'OPEN',
  'AUTHORIZED',
  'CAPTURED',
  'CANCELLED',
  'FENCED',
]);

// No default: the id is minted by the id service, not the database.
const id = () => snowflakeId('id').primaryKey();

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
    orderId: snowflakeId('order_id').notNull(),
    // Text, not an enum: a row records which gateway actually took the money, and old rows must stay
    // readable after the app stops offering that gateway — which a pgEnum could not do without
    // rewriting history.
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id').notNull(),
    providerIntentId: text('provider_intent_id'), // filled from the webhook / reconcile later
    // Matches orders.total_amount, which /pay copies here verbatim.
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    stripeKeyGen: integer('stripe_key_gen').notNull().default(0),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_payments_id_routable', t.id),
    routableIdCheck('ck_payments_order_id_routable', t.orderId),
    index('idx_payments_order').on(t.orderId),
    // At most one live payment per order — the DB backstop for "never double-charge". Partial so a
    // FAILED/EXPIRED attempt never blocks a legitimate retry. The app pre-checks too; this closes the
    // concurrent-double-submit race the check cannot. Written against the old enum values so the
    // migration that adds AUTHORIZED/VOIDED can rebuild it in the same transaction.
    uniqueIndex('uq_payments_one_active_per_order')
      .on(t.orderId)
      .where(sql`${t.status} not in ('FAILED', 'EXPIRED')`),
    index('idx_payments_status_updated_at').on(t.status, t.updatedAt),
  ],
);

// One row per order on the participant path: the fence every open/capture/cancel locks first.
export const paymentOrders = pgTable(
  'payment_orders',
  {
    orderId: snowflakeId('order_id').primaryKey(),
    status: paymentOrderStatus('status').notNull(),
    // Locked in by the first open; null only on a header a cancel fenced before any open.
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    currency: text('currency'),
    // Set once, together with the only `payment.authorized` the order ever emits.
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    routableIdCheck('ck_payment_orders_order_id_routable', t.orderId),
    check(
      'ck_payment_orders_amount_when_not_fenced',
      sql`${t.status} = 'FENCED' or (${t.amountMinor} is not null and ${t.currency} is not null)`,
    ),
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
    routableIdCheck('ck_webhook_events_id_routable', t.id),
    uniqueIndex('uq_webhook_provider_event').on(t.provider, t.providerEventId),
    // The retention sweep's predicate. The unique index above is on the identity pair, which says
    // nothing about age, so without this the sweep would scan every event ever received.
    index('idx_webhook_events_received').on(t.receivedAt),
  ],
);
