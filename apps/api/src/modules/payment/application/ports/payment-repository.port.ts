import type { DrizzleTx } from '@shared/infrastructure/database';
import type { PaymentOrderStatus } from '../../domain/payment-order-status';
import type { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';

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
  authorizedAt?: Date;
}

export interface StaleTccQuery {
  untouchedSince: Date;
  limit: number;
}

export interface StaleTccPayment {
  payment: Payment;
  headerStatus: PaymentOrderStatus;
}

export interface PaymentRepositoryPort {
  /** `id` is minted by a caller that must not mint inside its transaction; absent → minted here. */
  create(payment: Payment, tx?: DrizzleTx, id?: string): Promise<Payment>;

  /** The latest payment for an order — a retried checkout leaves older rows behind. */
  findByOrderId(orderId: string, tx?: DrizzleTx): Promise<Payment | null>;

  /** The one row the active-payment index allows, locked. */
  findActiveByOrderIdForUpdate(tx: DrizzleTx, orderId: string): Promise<Payment | null>;

  /** Every attempt for the order in id order; locked when given a tx. */
  findAllByOrderId(orderId: string, tx?: DrizzleTx): Promise<Payment[]>;

  findByProviderSessionId(providerSessionId: string, tx?: DrizzleTx): Promise<Payment | null>;

  /**
   * Fenced payments still owing an outcome: PENDING ones, and AUTHORIZED ones under a cancelled or
   * fenced header. Least recently touched first, so a probe that settles nothing does not starve the rest.
   */
  findStaleTcc(query: StaleTccQuery): Promise<StaleTccPayment[]>;

  /** Moves the row to the back of the stale queue without changing what it records. */
  touch(id: string): Promise<void>;

  /** Compare-and-set on the generation the caller read; false when another caller rotated first. */
  bumpKeyGen(id: string, expectedGen: number, tx?: DrizzleTx): Promise<boolean>;

  /** Null when the id is unknown or `expectedStatus` no longer matches. The adapter only writes —
   * the state-machine guard lives in the domain entity. */
  updateStatus(id: string, status: PaymentStatus, options?: UpdatePaymentStatusOptions): Promise<Payment | null>;
}
