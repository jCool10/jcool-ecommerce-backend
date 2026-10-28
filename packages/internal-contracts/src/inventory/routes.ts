import type { CommandOutcome, ReservationCommand, TryOutcome } from './types';

export const RESERVATIONS_PREFIX = 'internal/v1/reservations';

export const reservationRoutes = {
  try: (orderId: string) => `/${RESERVATIONS_PREFIX}/${encodeURIComponent(orderId)}/try`,
  command: (orderId: string, command: ReservationCommand) =>
    `/${RESERVATIONS_PREFIX}/${encodeURIComponent(orderId)}/${command}`,
  status: `/${RESERVATIONS_PREFIX}/status`,
};

// A refusal is a 409 carrying its outcome, so a caller tells it from a 409 some proxy made up.
export const TRY_OUTCOME_STATUS: Record<TryOutcome, 201 | 409> = {
  RESERVED: 201,
  OUT_OF_STOCK: 409,
  CONTENDED: 409,
  CONFLICT: 409,
};

export const COMMAND_OUTCOME_STATUS: Record<CommandOutcome, 200 | 409> = {
  APPLIED: 200,
  IDEMPOTENT: 200,
  CONFLICT: 409,
};

// Any route that takes row locks can answer it, with `Retry-After`; nothing was written.
export const LOCK_BUDGET_EXHAUSTED_STATUS = 503;
