import type { OutboxRecord } from '@shared/messaging/outbox/outbox-writer.port';

// The payload is a snapshot, not a reference: the consumer that signals the saga must not have to
// read Payment's tables to know which order was authorized and for how much.

const AGGREGATE_TYPE = 'Payment';

export interface PaymentAuthorizedFacts {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  /** The same instant written to `payment_orders.authorized_at`. */
  authorizedAt: Date;
}

export function toAuthorizedOutboxRecord(facts: PaymentAuthorizedFacts): OutboxRecord {
  return {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: facts.paymentId,
    eventType: 'payment.authorized',
    payload: {
      paymentId: facts.paymentId,
      orderId: facts.orderId,
      amountMinor: facts.amountMinor,
      currency: facts.currency,
      authorizedAt: facts.authorizedAt.toISOString(),
    },
  };
}
