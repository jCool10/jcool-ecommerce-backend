import type { DrizzleTx } from '@shared/infrastructure/database';
import type { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';

// Payment persistence port; the Drizzle adapter implements it in infrastructure/.
export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/** The active-payment partial-unique index firing — the DB backstop for "never double-charge". */
export class DuplicateActivePaymentError extends Error {
  constructor(orderId: string) {
    super(`Order already has an active payment: ${orderId}`);
    this.name = 'DuplicateActivePaymentError';
  }
}

export interface UpdatePaymentStatusOptions {
  providerIntentId?: string | null;
  tx?: DrizzleTx;
  /**
   * Compare-and-set guard for callers that decided on an unlocked read: pass the status you read and
   * a webhook that settled the payment meanwhile is detected (null return) instead of overwritten.
   */
  expectedStatus?: PaymentStatus;
}

export interface PaymentRepositoryPort {
  create(payment: Payment, tx?: DrizzleTx): Promise<Payment>;

  /** The latest payment for an order (newest first); null if it has none. */
  findByOrderId(orderId: string, tx?: DrizzleTx): Promise<Payment | null>;

  /** How the webhook resolves its target payment, from `data.object.id`. */
  findByProviderSessionId(providerSessionId: string, tx?: DrizzleTx): Promise<Payment | null>;

  /** Null when the id is unknown or `expectedStatus` no longer matches. The adapter only writes —
   * the state-machine guard lives in the domain entity. */
  updateStatus(id: string, status: PaymentStatus, options?: UpdatePaymentStatusOptions): Promise<Payment | null>;
}
