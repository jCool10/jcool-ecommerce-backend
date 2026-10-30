import type { InventoryContractDriver, StockLevel } from './contract-cases';
import { commandOutcomeOf, isLockBudgetExhausted, statusesOf, tryOutcomeOf } from './guards';
import { reservationRoutes } from './routes';
import { LOCK_BUDGET_EXHAUSTED } from './types';

export interface HttpContractDriverOptions {
  baseUrl: string;
  token: string;
  newId(): string;
  /** Stock is arranged and read behind the API, the way each runner's own fixtures do it. */
  seedStock(variantId: string, onHand: number): Promise<void>;
  stockOf(variantId: string): Promise<StockLevel | null>;
  lockStock(variantId: string): Promise<() => Promise<void>>;
}

interface Answer {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

// Busy rows are only an answer with the retry hint the contract promises alongside them.
const busyOf = ({ status, body, retryAfter }: Answer) =>
  isLockBudgetExhausted(status, body) && retryAfter !== null ? LOCK_BUDGET_EXHAUSTED : undefined;

/** Drives the internal API exactly as a caller would, failing on any status the contract does not name. */
export function httpContractDriver({ baseUrl, token, ...arrange }: HttpContractDriverOptions): InventoryContractDriver {
  const post = async (path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as unknown,
      retryAfter: response.headers.get('retry-after'),
    };
  };
  const unexpected = (path: string, answer: Answer) =>
    new Error(`${path} answered ${answer.status} ${JSON.stringify(answer.body)}`);

  return {
    ...arrange,
    async tryReserve(orderId, lines, holdUntil) {
      const path = reservationRoutes.try(orderId);
      const answer = await post(path, { lines, holdUntil: holdUntil.toISOString() });
      const outcome = tryOutcomeOf(answer.status, answer.body) ?? busyOf(answer);
      if (!outcome) throw unexpected(path, answer);
      return outcome;
    },
    async command(orderId, command) {
      const path = reservationRoutes.command(orderId, command);
      const answer = await post(path);
      const outcome = commandOutcomeOf(answer.status, answer.body) ?? busyOf(answer);
      if (!outcome) throw unexpected(path, answer);
      return outcome;
    },
    async statusOf(orderIds) {
      const answer = await post(reservationRoutes.status, { orderIds });
      const statuses = answer.status === 200 ? statusesOf(answer.body, orderIds) : undefined;
      if (!statuses) throw unexpected(reservationRoutes.status, answer);
      return statuses;
    },
  };
}
