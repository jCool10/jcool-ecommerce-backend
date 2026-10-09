export const PAYMENT_TCC = Symbol('PAYMENT_TCC');

export interface PaymentSession {
  paymentId: string;
  providerSessionId: string;
  redirectUrl?: string;
  clientSecret?: string;
}

export type OpenSessionAnswer = { outcome: 'OPENED'; session: PaymentSession } | { outcome: 'CLOSED' };

/** The gateway could not be reached; nothing was opened that the caller needs to undo. */
export class PaymentUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Payment provider is temporarily unavailable', options);
    this.name = 'PaymentUnavailableError';
  }
}

/** Idempotent per order; a throw means the outcome is unknown and the same call is retried. */
export interface PaymentTccPort {
  openSession(input: {
    orderId: string;
    amountMinor: number;
    currency: string;
    expiresAt: Date;
  }): Promise<OpenSessionAnswer>;
  capture(orderId: string): Promise<'CAPTURED' | 'NOT_CAPTURABLE'>;
  cancel(orderId: string): Promise<'CANCELLED' | 'FENCED' | 'CAPTURED_CONFLICT'>;
}
