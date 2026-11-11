import type { OutboxRecord } from '@jcool/messaging/outbox-port';
import type { OrderFinalizedEvent } from '../domain/order.entity';
import type { OrderPlacedEvent } from '../domain/events/order-placed.event';
import type { OrderRefundedEvent } from '../domain/events/order-refunded.event';

// Order domain events → outbox rows. The payload is a snapshot, not a reference: a consumer
// replaying it days later must not need to re-read the order to know what happened.

const AGGREGATE_TYPE = 'Order';

type FinalizedEventName = OrderFinalizedEvent['eventName'];

export const ORDER_PLACED_EVENT = 'order.placed';
export const ORDER_PAID_EVENT = 'order.paid' satisfies FinalizedEventName;
export const ORDER_FAILED_EVENT = 'order.failed' satisfies FinalizedEventName;
export const ORDER_EXPIRED_EVENT = 'order.expired' satisfies FinalizedEventName;
export const ORDER_CANCELLED_EVENT = 'order.cancelled' satisfies FinalizedEventName;
export const ORDER_REFUNDED_EVENT = 'order.refunded' satisfies OrderRefundedEvent['eventName'];

/** OrderPlacedEvent predates the DomainEvent interface, so its name is spelled out here. */
export function toPlacedOutboxRecord(event: OrderPlacedEvent): OutboxRecord {
  return {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: event.orderId,
    eventType: ORDER_PLACED_EVENT,
    payload: {
      orderId: event.orderId,
      userId: event.userId,
      totalAmountMinor: event.totalAmountMinor,
      currency: event.currency,
      placedAt: event.placedAt.toISOString(),
    },
  };
}

/** `requestedBy` is the admin's user id, the durable record of who refunded the order. */
export function toRefundedOutboxRecord(event: OrderRefundedEvent): OutboxRecord {
  return {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: event.aggregateId,
    eventType: event.eventName,
    payload: {
      orderId: event.aggregateId,
      userId: event.userId,
      occurredAt: event.occurredAt.toISOString(),
      totalAmountMinor: event.totalAmountMinor,
      currency: event.currency,
      paymentRef: event.paymentRef,
      requestedBy: event.requestedBy,
      reason: event.reason,
    },
  };
}

export function toFinalizedOutboxRecord(event: OrderFinalizedEvent): OutboxRecord {
  return {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: event.aggregateId,
    eventType: event.eventName,
    payload: {
      orderId: event.aggregateId,
      userId: event.userId,
      occurredAt: event.occurredAt.toISOString(),
      ...(event.eventName === 'order.paid'
        ? {
            totalAmountMinor: event.totalAmountMinor,
            currency: event.currency,
            paymentRef: event.paymentRef,
          }
        : { reason: event.reason }),
    },
  };
}
