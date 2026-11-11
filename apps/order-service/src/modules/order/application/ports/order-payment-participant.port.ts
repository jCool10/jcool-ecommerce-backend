import type { SettledCaptureOutcome } from '../../domain/checkout-saga';

export const ORDER_PAYMENT_PARTICIPANT = Symbol('ORDER_PAYMENT_PARTICIPANT');

/** Mirrors Payment's `payment_orders` header. Declared here so Order never imports Payment. */
export type PaymentHoldStatus =
  'OPEN' | 'AUTHORIZED' | 'CAPTURED' | 'CANCELLED' | 'FENCED' | 'REFUNDING' | 'REFUNDED' | 'REFUND_FAILED';

export interface PaymentSessionInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  expiresAt: Date;
}

/** The provider, or the breaker in front of it, refused the call. Nothing was opened. */
export class PaymentProviderUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Payment provider unavailable', options);
    this.name = 'PaymentProviderUnavailableError';
  }
}

export type PaymentSessionResult =
  | { outcome: 'OPENED'; paymentId: string; redirectUrl?: string; clientSecret?: string; providerSessionId: string }
  | { outcome: 'CLOSED' };

/** CONFLICT: nothing is authorized yet, so the caller is out of order. */
export type PaymentCaptureOutcome = SettledCaptureOutcome | 'CONFLICT';

export type PaymentCancelOutcome = 'CANCELLED' | 'FENCED' | 'IDEMPOTENT' | 'CAPTURED_CONFLICT';

/** PENDING: the provider holds the refund, ask again later. NOT_REFUNDABLE: nothing captured to refund. */
export type PaymentRefundOutcome = 'REFUNDED' | 'IDEMPOTENT' | 'PENDING' | 'REFUND_FAILED' | 'NOT_REFUNDABLE';

export interface PaymentRefundResult {
  outcome: PaymentRefundOutcome;
  /** The provider's failure code on REFUND_FAILED; never a raw provider message. */
  reason?: string;
}

export interface OrderPaymentStatus {
  header: PaymentHoldStatus | null;
  /** The payment holding (or holding then captured) the money; null when there is none. */
  authorizedPaymentId: string | null;
  hasAuthorizedAttempt: boolean;
  hasSucceededAttempt: boolean;
}

interface CallOptions {
  /** Aborted when the caller gives up, e.g. a cancelled activity or a worker shutting down. */
  signal?: AbortSignal;
}

/**
 * Payment's TCC participant as the checkout saga sees it. Commands are idempotent per order; business
 * outcomes are returned, Stripe and DB faults thrown for the caller to retry.
 */
export interface OrderPaymentParticipantPort {
  openSession(input: PaymentSessionInput, options?: CallOptions): Promise<PaymentSessionResult>;

  capture(orderId: string, options?: CallOptions): Promise<PaymentCaptureOutcome>;

  cancel(orderId: string, options?: CallOptions): Promise<PaymentCancelOutcome>;

  /** Refunds the whole captured amount, once per order; `requestedBy` is recorded the first time only. */
  refund(orderId: string, requestedBy: string, options?: CallOptions): Promise<PaymentRefundResult>;

  /** Every id asked for gets a key. At most 200 ids per call. */
  statusOf(orderIds: string[], options?: CallOptions): Promise<Map<string, OrderPaymentStatus>>;
}
