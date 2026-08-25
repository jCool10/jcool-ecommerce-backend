// Barrel for drizzle-kit config + the `DrizzleDB = NodePgDatabase<typeof schema>` generic.
// Table ownership lives in each module's `infrastructure/schema/`; this is a tooling boundary,
// NOT a shared data model — cross-context code must never reach a table through it.
export * from '../../../../modules/catalog/infrastructure/schema/catalog.schema';
export * from '../../../../modules/user/infrastructure/schema/user.schema';
export * from '../../../../modules/cart/infrastructure/schema/cart.schema';
export * from '../../../../modules/order/infrastructure/schema/order.schema';
export * from '../../../../modules/order/infrastructure/schema/idempotency-key.schema';
export * from '../../../../modules/inventory/infrastructure/schema/inventory.schema';
export * from '../../../../modules/payment/infrastructure/schema/payment.schema';
// Not module tables: the outbox carries events from every context, the inbox records what a
// consumer has applied of them (ADR 0019).
export * from '../../../messaging/outbox/schema/outbox.schema';
export * from '../../../messaging/inbox/schema/inbox.schema';
