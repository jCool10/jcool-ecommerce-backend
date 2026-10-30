/** Declaration order matches inventory's `reservation_order_status` enum. */
export const RESERVATION_ORDER_STATUSES = ['HELD', 'COMMITTED', 'RELEASED', 'FENCED', 'RESTOCKED'] as const;
export type ReservationOrderStatus = (typeof RESERVATION_ORDER_STATUSES)[number];

export const TRY_OUTCOMES = ['RESERVED', 'OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const;
export type TryOutcome = (typeof TRY_OUTCOMES)[number];

export const COMMAND_OUTCOMES = ['APPLIED', 'IDEMPOTENT', 'CONFLICT'] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

/** The `code` of a 503 for rows too busy to lock within the command's budget: retry, the service is fine. */
export const LOCK_BUDGET_EXHAUSTED = 'LOCK_BUDGET_EXHAUSTED';
export type LockBudgetExhausted = typeof LOCK_BUDGET_EXHAUSTED;

export const RESERVATION_COMMANDS = ['commit', 'release', 'restock'] as const;
export type ReservationCommand = (typeof RESERVATION_COMMANDS)[number];

export interface ReservationLineBody {
  variantId: string;
  quantity: number;
}

export interface TryReservationBody {
  /** At most one line per variant. */
  lines: ReservationLineBody[];
  /** ISO-8601, in the future. */
  holdUntil: string;
}

export interface TryReservationResponse {
  outcome: TryOutcome;
}

export interface CommandResponse {
  outcome: CommandOutcome;
}

/** Only `code` is read; the rest is the service's usual error envelope. */
export interface LockBudgetExhaustedResponse {
  statusCode: number;
  code: LockBudgetExhausted;
  message: string;
  requestId?: string;
}

export interface StatusBody {
  orderIds: string[];
}

export interface StatusResponse {
  /** Every id asked for is a key; `null` when inventory never heard of the order. */
  statuses: Record<string, ReservationOrderStatus | null>;
}
