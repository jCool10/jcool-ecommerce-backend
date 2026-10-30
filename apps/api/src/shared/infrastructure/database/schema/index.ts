// Table ownership lives in each module's `infrastructure/`; this is a drizzle-kit tooling
// boundary, NOT a shared data model — cross-context code must never reach a table through it.
export * from '../../../../modules/product/infrastructure/catalog/schema/catalog.schema';
export * from '../../../../modules/cart/infrastructure/schema/cart.schema';
export * from '../../../../modules/media/infrastructure/schema/media.schema';
// Kept until the drop, so drizzle-kit sees no change; nothing in the api touches them.
export * from './retired/order.schema';
// Not module tables: the outbox carries events from every context, the inbox records what a
// consumer has applied of them.
export * from '@jcool/messaging/schema';
