export const PAYMENT_PARTICIPANT = Symbol('PAYMENT_PARTICIPANT');

export interface OpenSessionInput {
  orderId: string;
  /** The caller's figure, fixed by the first open: every later open must repeat it. */
  amountMinor: number;
  currency: string;
  /** When the hosted page must stop taking money; below the configured floor the open is refused. */
  expiresAt: Date;
}

export type OpenSessionResult =
  | { outcome: 'OPENED'; paymentId: string; providerSessionId: string; redirectUrl?: string; clientSecret?: string }
  | { outcome: 'CLOSED' };

/** `openSession` could not reach the gateway; nothing was opened that the caller must undo. */
export class PaymentProviderUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Payment provider is temporarily unavailable', options);
    this.name = 'PaymentProviderUnavailableError';
  }
}

export type CaptureOutcome = 'CAPTURED' | 'NOT_CAPTURABLE';

export type CancelOutcome = 'CANCELLED' | 'FENCED' | 'CAPTURED_CONFLICT';

/**
 * Idempotent per order behind the `payment_orders` fence, so calls may arrive in any order. Outcomes
 * are returned; a throw means unknown, and the caller retries the same call.
 */
export interface PaymentParticipant {
  openSession(input: OpenSessionInput): Promise<OpenSessionResult>;
  capture(orderId: string): Promise<{ outcome: CaptureOutcome }>;
  cancel(orderId: string): Promise<{ outcome: CancelOutcome }>;
}
