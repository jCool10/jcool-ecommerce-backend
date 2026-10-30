import { ORDER_PAID_BACKOFF } from '@jcool/internal-contracts/queues/order-events';
import type { EventRoutes, QueueDefinition, QueueSpec } from '@jcool/messaging';
import {
  CATEGORY_RENAMED_EVENT,
  PRODUCT_CHANGED_EVENT,
} from '@modules/product/application/catalog/catalog-outbox.mapper';

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

/** Order events are published by the order-service's own outbox. */
export const API_EVENT_ROUTES: EventRoutes = {
  [PRODUCT_CHANGED_EVENT]: API_EVENTS,
  [CATEGORY_RENAMED_EVENT]: API_EVENTS,
};

export type ApiConsumedQueue = Omit<QueueDefinition, 'dispatcher'>;

/** Without their dispatcher, so the replay CLI can pick one without loading the Nest graph. */
export const API_CONSUMED_QUEUES: readonly ApiConsumedQueue[] = [{ ...API_EVENTS, consumer: API_EVENTS_CONSUMER }];
