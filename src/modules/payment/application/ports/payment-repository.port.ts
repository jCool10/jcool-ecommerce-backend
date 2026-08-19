import type { DrizzleTx } from '@shared/infrastructure/database';
import type { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';

// Payment persistence port; the Drizzle adapter implements it in infrastructure/. Keeps
// the application free of drizzle-orm/schema. Methods accept an optional transaction so a
// payment write can join the caller's unit of work.
export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/**
 * Raised by `create` when the active-payment partial-unique index rejects a second concurrent
 * insert for an order — the DB backstop for "never double-charge". The application maps it to a
 * 409, the same outcome as the pre-insert guard the race slipped past.
 */
export class DuplicateActivePaymentError extends Error {
  constructor(orderId: string) {
    super(`Order already has an active payment: ${orderId}`);
    this.name = 'DuplicateActivePaymentError';
  }
}

export interface UpdatePaymentStatusOptions {
  providerIntentId?: string | null;
  tx?: DrizzleTx;
}

export interface PaymentRepositoryPort {
  create(payment: Payment, tx?: DrizzleTx): Promise<Payment>;

  /** The latest payment for an order (newest first); null if it has none. */
  findByOrderId(orderId: string): Promise<Payment | null>;

  /**
   * Persist a status change (and optionally the provider intent id); returns the updated
   * payment, or null if the id is unknown. The state-machine guard lives in the domain
   * entity — the adapter only writes.
   */
  updateStatus(id: string, status: PaymentStatus, options?: UpdatePaymentStatusOptions): Promise<Payment | null>;
}
