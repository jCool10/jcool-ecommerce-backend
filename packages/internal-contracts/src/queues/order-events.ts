import { PAYMENT_AUTHORIZED_EVENT } from '../events/payment-authorized';

// Every producer of the queue adds jobs with these options, since BullMQ stamps them at `add`: a
// relay that disagrees puts its jobs on another ladder than the consumer expects.

export const ORDER_EVENTS_QUEUE = 'order-events';

/** No worker on purpose: poison waits here for a human to replay or drop it. */
export const ORDER_EVENTS_DLQ = 'order-events-dlq';

/** A consumer group, not a process: every instance dedups against the same inbox rows. */
export const ORDER_EVENTS_CONSUMER = 'order-events';

/** A custom backoff type, so the consumer's worker alone decides the delays and their cap. */
export const ORDER_PAID_BACKOFF = 'order-paid';

export interface LongLadderJobOptions {
  attempts: number;
  backoff: { type: typeof ORDER_PAID_BACKOFF };
}

const LONG_LADDER = new Set(['order.paid', PAYMENT_AUTHORIZED_EVENT]);

/** Overrides of the queue defaults for events that wait on another service while they retry. */
export function orderEventsJobOptions(
  eventType: string,
  orderPaidAttempts: number,
): LongLadderJobOptions | Record<string, never> {
  return LONG_LADDER.has(eventType) ? { attempts: orderPaidAttempts, backoff: { type: ORDER_PAID_BACKOFF } } : {};
}
