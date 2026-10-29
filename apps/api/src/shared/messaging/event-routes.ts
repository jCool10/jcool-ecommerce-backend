import { PAYMENT_AUTHORIZED_EVENT } from '@jcool/internal-contracts/events/payment-authorized';
import {
  ORDER_EVENTS_CONSUMER,
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  ORDER_PAID_BACKOFF,
  orderEventsJobOptions,
} from '@jcool/internal-contracts/queues/order-events';
import type { EventRoutes, QueueDefinition, QueueSpec } from '@jcool/messaging';
import {
  ORDER_CANCELLED_EVENT,
  ORDER_EXPIRED_EVENT,
  ORDER_FAILED_EVENT,
  ORDER_PAID_EVENT,
  ORDER_PLACED_EVENT,
} from '@modules/order/application/order-outbox.mapper';
import {
  CATEGORY_RENAMED_EVENT,
  PRODUCT_CHANGED_EVENT,
} from '@modules/product/application/catalog/catalog-outbox.mapper';

export const ORDER_EVENTS: QueueSpec = {
  name: ORDER_EVENTS_QUEUE,
  dlq: ORDER_EVENTS_DLQ,
  jobOptionsFor: orderEventsJobOptions,
};

export const API_EVENTS_QUEUE = 'api-events';
export const API_EVENTS_DLQ = 'api-events-dlq';
export const API_EVENTS_CONSUMER = 'api-events';

/** Catalog events wait on the search engine, so they retry for as long as it may be down. */
export const API_EVENTS: QueueSpec = {
  name: API_EVENTS_QUEUE,
  dlq: API_EVENTS_DLQ,
  jobOptionsFor: (eventType, attempts) =>
    eventType.startsWith('catalog.') ? { attempts, backoff: { type: ORDER_PAID_BACKOFF } } : {},
};

/**
 * `payment.authorized` is no longer written here, but rows written before the cut-over and a rollback
 * that brings payment back both still need the route.
 */
export const API_EVENT_ROUTES: EventRoutes = {
  [ORDER_PLACED_EVENT]: ORDER_EVENTS,
  [ORDER_PAID_EVENT]: ORDER_EVENTS,
  [ORDER_FAILED_EVENT]: ORDER_EVENTS,
  [ORDER_EXPIRED_EVENT]: ORDER_EVENTS,
  [ORDER_CANCELLED_EVENT]: ORDER_EVENTS,
  [PAYMENT_AUTHORIZED_EVENT]: ORDER_EVENTS,
  [PRODUCT_CHANGED_EVENT]: API_EVENTS,
  [CATEGORY_RENAMED_EVENT]: API_EVENTS,
};

export type ApiConsumedQueue = Omit<QueueDefinition, 'dispatcher'>;

/** Without their dispatcher, so the replay CLI can pick one without loading the Nest graph. */
export const API_CONSUMED_QUEUES: readonly ApiConsumedQueue[] = [
  { ...ORDER_EVENTS, consumer: ORDER_EVENTS_CONSUMER },
  { ...API_EVENTS, consumer: API_EVENTS_CONSUMER },
];
