import { DomainError } from '@jcool/kernel';
import type { IdempotencyContext } from '@shared/idempotency';
import type { TryVerdict } from '../../domain/checkout-saga';
import type { Order } from '../../domain/order.entity';

export const CHECKOUT_SAGA_ENGINE = Symbol('CHECKOUT_SAGA_ENGINE');

export interface CheckoutStart {
  orderId: string;
  lines: { skuId: string; quantity: number }[];
  totalMinor: number;
  currency: string;
  placedAt: Date;
  deadlineAt: Date;
  holdUntil: Date;
  /** Present only when a request is waiting on the Try; tx B completes its key. */
  idempotency?: IdempotencyContext;
}

export interface PaymentAuthorization {
  paymentId: string;
  amountMinor: number;
  currency: string;
  authorizedAt: Date;
}

/** The engine could not be reached or did not answer in time; whatever it was asked may still run. */
export class CheckoutEngineUnavailableError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Checkout saga engine unavailable during ${operation}`, options);
    this.name = 'CheckoutEngineUnavailableError';
  }
}

export class CheckoutNotCancellableError extends DomainError {
  constructor(orderId: string) {
    super(`Checkout for order ${orderId} is past the point where it can be cancelled`);
    this.name = 'CheckoutNotCancellableError';
  }
}

export interface CheckoutSagaEnginePort {
  /** Starts the saga or attaches to the one already running for the order, and waits for the Try. */
  reserve(start: CheckoutStart): Promise<TryVerdict>;
  /** `closed`: no saga is running for the order any more. Throws `CheckoutNotCancellableError`. */
  cancel(orderId: string, by: 'user' | 'admin'): Promise<'accepted' | 'closed'>;
  /** Signals the running saga, or opens one that voids the money when the saga has already closed. */
  notifyAuthorized(orderId: string, authorization: PaymentAuthorization): Promise<void>;
  /** Starts the saga if none is running; a no-op otherwise. */
  ensureStarted(start: CheckoutStart): Promise<void>;
}

export function checkoutStartFor(order: Order, holdSafetyMs: number, idempotency?: IdempotencyContext): CheckoutStart {
  if (order.id === null || order.placedAt === null || order.paymentDeadlineAt === null) {
    throw new DomainError('Only a placed order with a payment deadline can start a checkout saga');
  }
  return {
    orderId: order.id,
    lines: order.items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
    totalMinor: order.totalAmountMinor,
    currency: order.currency,
    placedAt: order.placedAt,
    deadlineAt: order.paymentDeadlineAt,
    holdUntil: new Date(order.paymentDeadlineAt.getTime() + holdSafetyMs),
    idempotency,
  };
}
