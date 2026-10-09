import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';

export const CHECKOUT_SAGA_REPOSITORY = Symbol('CHECKOUT_SAGA_REPOSITORY');

export interface CheckoutSaga {
  orderId: string;
  step: CheckoutSagaStep;
  pendingCompensations: Compensation[];
  deadlineAt: Date;
  nextAttemptAt: Date;
  attempts: number;
  leaseUntil: Date | null;
  lastError: string | null;
  version: number;
}

export interface CheckoutSagaUpdate {
  step: CheckoutSagaStep;
  pendingCompensations: readonly Compensation[];
  nextAttemptAt: Date;
  attempts: number;
  lastError: string | null;
}

/**
 * Every write bumps `version`. Whoever holds the lease compares-and-sets on the version its claim
 * returned, so any other write in between (another owner, a handler, a cancel) makes its next renew
 * or apply lose, and it stops without overwriting anything.
 */
export interface CheckoutSagaRepositoryPort {
  /** RESERVING, already leased to the request inserting it, exactly as a claim would leave it. */
  insertLeased(tx: DrizzleTx, input: { orderId: string; deadlineAt: Date; leaseMs: number }): Promise<CheckoutSaga>;

  /** Null when another owner's lease is still running or the saga is terminal. */
  claim(orderId: string, leaseMs: number): Promise<CheckoutSaga | null>;

  /** The new version, or null when another write moved it first. */
  renew(orderId: string, version: number, leaseMs: number): Promise<number | null>;

  /** Releases the lease. False when another write moved the version first. */
  applyLeased(tx: DrizzleTx, orderId: string, version: number, update: CheckoutSagaUpdate): Promise<boolean>;

  /** A write from outside any advance, under the caller's lock on the saga row; the lease is left alone. */
  rewrite(tx: DrizzleTx, orderId: string, update: CheckoutSagaUpdate): Promise<void>;

  findForUpdate(tx: DrizzleTx, orderId: string): Promise<CheckoutSaga | null>;

  findByOrderId(orderId: string): Promise<CheckoutSaga | null>;

  /** Read-only and lock-free: an advance's claim is what keeps two callers off one saga. */
  findDue(limit: number): Promise<string[]>;
}
