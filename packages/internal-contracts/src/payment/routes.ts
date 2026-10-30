import type { CancelOutcome, CaptureOutcome, SessionOutcome } from './types';

export const PAYMENTS_PREFIX = 'internal/v1/payments';

const orderPath = (orderId: string, command: string) => `/${PAYMENTS_PREFIX}/${encodeURIComponent(orderId)}/${command}`;

export const paymentRoutes = {
  session: (orderId: string) => orderPath(orderId, 'session'),
  capture: (orderId: string) => orderPath(orderId, 'capture'),
  cancel: (orderId: string) => orderPath(orderId, 'cancel'),
  status: `/${PAYMENTS_PREFIX}/status`,
};

// As with inventory, a refusal is a 409 that names itself.
export const SESSION_OUTCOME_STATUS: Record<SessionOutcome, 200 | 409> = {
  OPENED: 200,
  CLOSED: 409,
};

export const CAPTURE_OUTCOME_STATUS: Record<CaptureOutcome, 200 | 409> = {
  CAPTURED: 200,
  IDEMPOTENT: 200,
  NOT_CAPTURABLE: 409,
  CONFLICT: 409,
};

// Any route that reaches Stripe can answer it, with `Retry-After`.
export const PROVIDER_UNAVAILABLE_STATUS = 503;

export const CANCEL_OUTCOME_STATUS: Record<CancelOutcome, 200 | 409> = {
  CANCELLED: 200,
  FENCED: 200,
  IDEMPOTENT: 200,
  CAPTURED_CONFLICT: 409,
};
