export * from '../modules/payment/infrastructure/schema/payment.schema';
// No inbox: this service consumes no queue, and webhook dedup lives in webhook_events.
export { outbox } from '@jcool/messaging/schema';
