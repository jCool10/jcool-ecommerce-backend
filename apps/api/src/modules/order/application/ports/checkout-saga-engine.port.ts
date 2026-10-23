import type {
  CancelBy,
  CheckoutSagaMode,
  CheckoutStep,
  PaymentAuthorization,
  ReserveOutcome,
} from '../../domain/checkout-saga';

export const CHECKOUT_SAGA_ENGINE = Symbol('CHECKOUT_SAGA_ENGINE');

/** The engine could not answer in its wait budget; whatever was sent may still land. */
export class CheckoutEngineUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Checkout saga engine unavailable', options);
    this.name = 'CheckoutEngineUnavailableError';
  }
}

export class CheckoutCancelRejectedError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly step: CheckoutStep | null,
  ) {
    super(`Checkout ${orderId} cannot be cancelled at step ${step ?? 'unknown'}`);
    this.name = 'CheckoutCancelRejectedError';
  }
}

/** The order's saga run has already closed, so it takes no more commands. */
export class CheckoutSagaClosedError extends Error {
  constructor(public readonly orderId: string) {
    super(`Checkout saga for order ${orderId} is closed`);
    this.name = 'CheckoutSagaClosedError';
  }
}

export interface CheckoutSagaStart {
  mode: CheckoutSagaMode;
  orderId: string;
  userId: string;
  lines: { skuId: string; quantity: number }[];
  totalMinor: number;
  currency: string;
  placedAt: Date;
  deadlineAt: Date;
}

/**
 * Drives one checkout saga per order. Every call is bounded by its own wait budget and throws
 * CheckoutEngineUnavailableError past it.
 */
export interface CheckoutSagaEnginePort {
  /** Starts the saga if needed and waits for the Try; a repeat returns the recorded outcome. */
  reserve(start: CheckoutSagaStart): Promise<ReserveOutcome>;

  /** Resolves once stock and payment are compensated. */
  cancel(orderId: string, by: CancelBy): Promise<void>;

  /** Delivers to the open run, or starts a late-authorization run when the saga has closed. */
  notifyAuthorized(start: CheckoutSagaStart, authorization: PaymentAuthorization): Promise<void>;

  /** No-op while a run is open; throws CheckoutSagaClosedError once it has closed. */
  ensureStarted(start: CheckoutSagaStart): Promise<void>;
}
