import {
  PAYMENT_AUTHORIZED_EVENT,
  paymentAuthorizedPayload,
} from '@jcool/internal-contracts/events/payment-authorized';
import type { OutboxRecord } from '@jcool/messaging/outbox-port';

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
    eventType: PAYMENT_AUTHORIZED_EVENT,
    payload: { ...paymentAuthorizedPayload(facts) },
  };
}
