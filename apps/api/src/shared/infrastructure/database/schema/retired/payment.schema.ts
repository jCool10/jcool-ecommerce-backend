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

// Retired: the payment-service owns these tables now and nothing here reads or writes them. The
// definitions stay only so drizzle-kit generates no DROP before the tables are dropped on purpose.

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

const id = () => snowflakeId('id').primaryKey();

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: snowflakeId('order_id').notNull(),
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id').notNull(),
    providerIntentId: text('provider_intent_id'),
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
    uniqueIndex('uq_payments_one_active_per_order')
      .on(t.orderId)
      .where(sql`${t.status} not in ('FAILED', 'EXPIRED')`),
    index('idx_payments_status_updated_at').on(t.status, t.updatedAt),
  ],
);

export const paymentOrders = pgTable(
  'payment_orders',
  {
    orderId: snowflakeId('order_id').primaryKey(),
    status: paymentOrderStatus('status').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    currency: text('currency'),
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
    index('idx_webhook_events_received').on(t.receivedAt),
  ],
);
