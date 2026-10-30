export * from '../modules/order/infrastructure/schema/order.schema';
export * from '../modules/order/infrastructure/schema/idempotency-key.schema';
// order.* leaves through the outbox; the inbox fences the order-events consumer.
export * from '@jcool/messaging/schema';
