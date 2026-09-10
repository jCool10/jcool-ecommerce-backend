// Table ownership lives in each module's `infrastructure/schema/`; this is a drizzle-kit tooling
// boundary, NOT a shared data model — cross-context code must never reach a table through it.
export * from '../../modules/catalog/infrastructure/schema/catalog.schema';
export * from '../../modules/cart/infrastructure/schema/cart.schema';
export * from '../../modules/order/infrastructure/schema/order.schema';
export * from '../../modules/order/infrastructure/schema/idempotency-key.schema';
export * from '../../modules/inventory/infrastructure/schema/inventory.schema';
export * from '../../modules/payment/infrastructure/schema/payment.schema';
export * from '../../modules/media/infrastructure/schema/media.schema';
// Not module tables: the outbox carries events from every context, the inbox records what a
// consumer has applied of them.
export * from '../../../../../libs/messaging/src/outbox/schema/outbox.schema';
export * from '../../../../../libs/messaging/src/inbox/schema/inbox.schema';
