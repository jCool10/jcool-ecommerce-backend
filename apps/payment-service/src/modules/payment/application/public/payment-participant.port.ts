import type { PaymentOrderStatus } from '../../domain/payment-order-status';

export const PAYMENT_PARTICIPANT = Symbol('PAYMENT_PARTICIPANT');

export type { PaymentOrderStatus };
// What every command throws when Stripe or its breaker refuses; the caller may tell it from a DB fault.
export { PaymentGatewayError } from '../ports/payment-gateway.port';

export interface OpenSessionInput {
  orderId: string;
  /** The order total. Locked in by the first open; any later open with a different charge is CLOSED. */
  amountMinor: number;
  currency: string;
  /** The session dies at this instant; too close to now and nothing is opened. */
  expiresAt: Date;
}

export type OpenSessionResult =
  | { outcome: 'OPENED'; paymentId: string; redirectUrl?: string; clientSecret?: string; providerSessionId: string }
  | { outcome: 'CLOSED' };

export type CaptureOutcome = 'CAPTURED' | 'IDEMPOTENT' | 'NOT_CAPTURABLE' | 'CONFLICT';

export type CancelOutcome = 'CANCELLED' | 'FENCED' | 'IDEMPOTENT' | 'CAPTURED_CONFLICT';

export interface PaymentParticipantStatus {
  header: PaymentOrderStatus | null;
  /** The payment currently holding or holding-then-captured the money, null when there is none. */
  authorizedPaymentId: string | null;
  hasAuthorizedAttempt: boolean;
  hasSucceededAttempt: boolean;
}

/**
 * Payment's TCC participant over Stripe manual capture, fenced per order by its `payment_orders`
 * header. Each command opens its own transactions and never holds one across a Stripe call. Business
 * outcomes are returned; a Stripe or DB fault is thrown and the caller retries the same command.
 * Payment never reads the order: amount and deadline come from the caller.
 *
 * capture answers CONFLICT when nothing was authorized yet (the caller is out of order) and
 * NOT_CAPTURABLE when the hold is gone. A cancel with no header yet writes FENCED, and every later
 * open is CLOSED.
 */
export interface PaymentParticipant {
  openSession(input: OpenSessionInput): Promise<OpenSessionResult>;

  capture(input: { orderId: string }): Promise<CaptureOutcome>;

  cancel(input: { orderId: string }): Promise<CancelOutcome>;

  /** One lock-free query for the whole batch; every id asked for gets a key. Callers send at most 200. */
  statusOf(orderIds: string[]): Promise<Map<string, PaymentParticipantStatus>>;
}
