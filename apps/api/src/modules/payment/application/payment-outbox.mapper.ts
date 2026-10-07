import type { OutboxRecord } from '@shared/messaging/outbox/outbox-writer.port';
import { PaymentStatus, type SettledPaymentStatus } from '../domain/payment-status';

// The payload is a snapshot, not a reference: the consumer that settles the order must not have to
// read Payment's tables to know which order settled and how.

const AGGREGATE_TYPE = 'Payment';

export interface PaymentSettledFacts {
  paymentId: string;
  orderId: string;
  status: SettledPaymentStatus;
  /** The gateway's handle for the money that moved, when it reported one. */
  paymentRef: string | null;
  settledAt: Date;
}

export function toSettledOutboxRecord(facts: PaymentSettledFacts): OutboxRecord {
  return {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: facts.paymentId,
    eventType: facts.status === PaymentStatus.SUCCEEDED ? 'payment.succeeded' : 'payment.failed',
    payload: {
      paymentId: facts.paymentId,
      orderId: facts.orderId,
      paymentRef: facts.paymentRef,
      settledAt: facts.settledAt.toISOString(),
    },
  };
}

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
