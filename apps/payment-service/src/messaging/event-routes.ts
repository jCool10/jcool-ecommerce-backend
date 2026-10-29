import { PAYMENT_AUTHORIZED_EVENT } from '@jcool/internal-contracts/events/payment-authorized';
import {
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  orderEventsJobOptions,
} from '@jcool/internal-contracts/queues/order-events';
import type { EventRoutes } from '@jcool/messaging';

/** The only event this service writes. It consumes nothing, so it runs no worker. */
export const PAYMENT_EVENT_ROUTES: EventRoutes = {
  [PAYMENT_AUTHORIZED_EVENT]: { name: ORDER_EVENTS_QUEUE, dlq: ORDER_EVENTS_DLQ, jobOptionsFor: orderEventsJobOptions },
};
