import {
  ORDER_EVENTS_CONSUMER,
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  orderEventsJobOptions,
} from '@jcool/internal-contracts/queues/order-events';
import type { EventRoutes, QueueDefinition, QueueSpec } from '@jcool/messaging';
import {
  ORDER_CANCELLED_EVENT,
  ORDER_EXPIRED_EVENT,
  ORDER_FAILED_EVENT,
  ORDER_PAID_EVENT,
  ORDER_PLACED_EVENT,
} from '../../modules/order/application/order-outbox.mapper';

export const ORDER_EVENTS: QueueSpec = {
  name: ORDER_EVENTS_QUEUE,
  dlq: ORDER_EVENTS_DLQ,
  jobOptionsFor: orderEventsJobOptions,
};

/** What this service's outbox publishes; payment.authorized arrives on the same queue from the payment-service. */
export const ORDER_EVENT_ROUTES: EventRoutes = {
  [ORDER_PLACED_EVENT]: ORDER_EVENTS,
  [ORDER_PAID_EVENT]: ORDER_EVENTS,
  [ORDER_FAILED_EVENT]: ORDER_EVENTS,
  [ORDER_EXPIRED_EVENT]: ORDER_EVENTS,
  [ORDER_CANCELLED_EVENT]: ORDER_EVENTS,
};

export type OrderConsumedQueue = Omit<QueueDefinition, 'dispatcher'>;

/** Without the dispatcher, so the replay CLI can pick one without loading the Nest graph. */
export const ORDER_CONSUMED_QUEUES: readonly OrderConsumedQueue[] = [
  { ...ORDER_EVENTS, consumer: ORDER_EVENTS_CONSUMER },
];
