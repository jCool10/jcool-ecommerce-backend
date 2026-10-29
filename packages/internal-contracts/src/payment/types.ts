/** Declaration order matches payment's `payment_order_status` enum. */
export const PAYMENT_ORDER_STATUSES = ['OPEN', 'AUTHORIZED', 'CAPTURED', 'CANCELLED', 'FENCED'] as const;
export type PaymentOrderStatus = (typeof PAYMENT_ORDER_STATUSES)[number];

export const SESSION_OUTCOMES = ['OPENED', 'CLOSED'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export const CAPTURE_OUTCOMES = ['CAPTURED', 'IDEMPOTENT', 'NOT_CAPTURABLE', 'CONFLICT'] as const;
export type CaptureOutcome = (typeof CAPTURE_OUTCOMES)[number];

export const CANCEL_OUTCOMES = ['CANCELLED', 'FENCED', 'IDEMPOTENT', 'CAPTURED_CONFLICT'] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

/** Stripe failed or its breaker is open. Not an outcome: the caller retries, as on any 503. */
export const PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE';
export type ProviderUnavailable = typeof PROVIDER_UNAVAILABLE;

export interface ProviderUnavailableResponse {
  statusCode: number;
  code: ProviderUnavailable;
  message: string;
  requestId?: string;
}

export interface OpenSessionBody {
  /** The order total, locked in by the first open; a later open with another charge is CLOSED. */
  amountMinor: number;
  currency: string;
  /** ISO-8601. Too close to now and the answer is CLOSED, not a 400. */
  expiresAt: string;
}

export type OpenSessionResponse =
  | {
      outcome: 'OPENED';
      /** The attempt the session belongs to; `/status` names it once it is authorized. */
      paymentId: string;
      providerSessionId: string;
      redirectUrl?: string;
      clientSecret?: string;
    }
  | { outcome: 'CLOSED' };

export interface CaptureResponse {
  outcome: CaptureOutcome;
}

export interface CancelResponse {
  outcome: CancelOutcome;
}

export interface PaymentStatusBody {
  orderIds: string[];
}

export interface PaymentStatusEntry {
  /** `null` when payment never heard of the order. */
  header: PaymentOrderStatus | null;
  /** The attempt holding, or holding then capturing, the money. */
  authorizedPaymentId: string | null;
  hasAuthorizedAttempt: boolean;
  hasSucceededAttempt: boolean;
}

export interface PaymentStatusResponse {
  /** Every id asked for is a key. */
  statuses: Record<string, PaymentStatusEntry>;
}
