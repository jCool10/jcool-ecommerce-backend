import type { OutboxRecord } from '@shared/messaging/outbox/outbox-writer.port';

// The payload is a snapshot, not a reference: the order side must not have to read Payment's tables
// to know which order the hold belongs to and how much it holds.

const AGGREGATE_TYPE = 'Payment';

export interface PaymentAuthorizedFacts {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
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
