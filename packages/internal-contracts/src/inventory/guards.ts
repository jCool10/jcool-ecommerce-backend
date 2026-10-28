import { COMMAND_OUTCOME_STATUS, LOCK_BUDGET_EXHAUSTED_STATUS, TRY_OUTCOME_STATUS } from './routes';
import {
  COMMAND_OUTCOMES,
  type CommandOutcome,
  type CommandResponse,
  LOCK_BUDGET_EXHAUSTED,
  RESERVATION_ORDER_STATUSES,
  type ReservationOrderStatus,
  type StatusResponse,
  TRY_OUTCOMES,
  type TryOutcome,
  type TryReservationResponse,
} from './types';

const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

const isTryOutcome = isOneOf(TRY_OUTCOMES);
const isCommandOutcome = isOneOf(COMMAND_OUTCOMES);
const isReservationOrderStatus = isOneOf(RESERVATION_ORDER_STATUSES);

const isRecord = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

export function isTryReservationResponse(body: unknown): body is TryReservationResponse {
  return isRecord(body) && isTryOutcome(body.outcome);
}

export function isCommandResponse(body: unknown): body is CommandResponse {
  return isRecord(body) && isCommandOutcome(body.outcome);
}

export function isStatusResponse(body: unknown): body is StatusResponse {
  return (
    isRecord(body) &&
    isRecord(body.statuses) &&
    Object.values(body.statuses).every((status) => status === null || isReservationOrderStatus(status))
  );
}

/** The outcome, or undefined when the status code and body do not agree on one. */
export function tryOutcomeOf(status: number, body: unknown): TryOutcome | undefined {
  return isTryReservationResponse(body) && TRY_OUTCOME_STATUS[body.outcome] === status ? body.outcome : undefined;
}

export function commandOutcomeOf(status: number, body: unknown): CommandOutcome | undefined {
  return isCommandResponse(body) && COMMAND_OUTCOME_STATUS[body.outcome] === status ? body.outcome : undefined;
}

/** A bare 503 is the service unwell; only the code says the rows were busy. */
export function isLockBudgetExhausted(status: number, body: unknown): boolean {
  return status === LOCK_BUDGET_EXHAUSTED_STATUS && isRecord(body) && body.code === LOCK_BUDGET_EXHAUSTED;
}

/** The statuses, or undefined when the body is malformed or leaves out an id that was asked for. */
export function statusesOf(
  body: unknown,
  orderIds: readonly string[],
): Map<string, ReservationOrderStatus | null> | undefined {
  if (!isStatusResponse(body)) return undefined;
  const { statuses } = body;
  if (!orderIds.every((orderId) => Object.hasOwn(statuses, orderId))) return undefined;
  return new Map(orderIds.map((orderId) => [orderId, statuses[orderId]]));
}
