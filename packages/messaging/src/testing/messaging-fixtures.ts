import { SEQUENCE_COUNT, encode } from '@jcool/id-codec';
import type { IdMinter } from '../messaging.options';
import type { QueueSpec } from '../queue/queue-definition';

/** A fixed, routable id, distinct per `n`. */
export function sampleId(n = 0): string {
  return encode({
    tsMs: Date.UTC(2026, 8, 1) + Math.floor(n / SEQUENCE_COUNT),
    nodeId: 1,
    sequence: n % SEQUENCE_COUNT,
  });
}

export class RecordingIdGenerator implements IdMinter {
  private minted = 0;

  mint(count = 1): Promise<string[]> {
    return Promise.resolve(Array.from({ length: count }, () => sampleId(this.minted++)));
  }
}

/** Two queues shaped like the api's: long-ladder events on each, everything else on the defaults. */
export const ORDERS: QueueSpec = {
  name: 'orders',
  dlq: 'orders-dlq',
  jobOptionsFor: (eventType, attempts) =>
    eventType === 'order.paid' || eventType === 'payment.authorized'
      ? { attempts, backoff: { type: 'order-paid' } }
      : {},
};

export const CATALOG: QueueSpec = {
  name: 'catalog',
  dlq: 'catalog-dlq',
  jobOptionsFor: (eventType, attempts) =>
    eventType.startsWith('catalog.') ? { attempts, backoff: { type: 'order-paid' } } : {},
};

export const ROUTES = {
  'order.placed': ORDERS,
  'order.paid': ORDERS,
  'payment.authorized': ORDERS,
  'catalog.product.changed': CATALOG,
};
