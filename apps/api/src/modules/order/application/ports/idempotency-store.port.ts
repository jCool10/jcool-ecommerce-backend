import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// The unique (scope, key) index — not an application if-check — is the concurrency backstop: a
// racing duplicate loses the INSERT rather than creating a second order.
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface IdempotencyRecord {
  id: string;
  scope: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
  orderId: string | null;
  method: string;
  path: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface InsertInProgressInput {
  scope: string;
  key: string;
  requestHash: string;
  method: string;
  path: string;
  expiresAt: Date;
}

export interface MarkCompletedInput {
  scope: string;
  key: string;
  responseStatus: number;
  responseBody: unknown;
  orderId?: string | null;
}

export interface IdempotencyStorePort {
  /**
   * INSERT ... ON CONFLICT (scope, key) DO NOTHING. Returns the new IN_PROGRESS record on a
   * win, or null when the key already exists (race / duplicate) — the conflict never throws,
   * so the caller branches on replay vs 409 instead of catching an error.
   */
  tryInsertInProgress(input: InsertInProgressInput): Promise<IdempotencyRecord | null>;

  findByScopeAndKey(scope: string, key: string): Promise<IdempotencyRecord | null>;

  /**
   * Freeze the result: status → COMPLETED with the response to replay. Pass `tx` to join the
   * checkout transaction so the key commits atomically with the order + reservation; omit it to run
   * standalone — the crash-reclaim heal, which points the key at an order an earlier attempt already
   * committed, outside any transaction. Only a committed success is ever frozen: a thrown handler
   * result drops the IN_PROGRESS row instead (see IdempotencyInterceptor), so a business 4xx must
   * never be cached here or the client could never fix and retry the request.
   */
  markCompleted(input: MarkCompletedInput, tx?: DrizzleTx): Promise<void>;

  /**
   * Remove an IN_PROGRESS row so the client can retry — called when the handler failed with an
   * unexpected error (the deterministic result was never recorded).
   */
  deleteInProgress(scope: string, key: string, tx?: DrizzleTx): Promise<void>;

  /**
   * Reclaim guard: delete an IN_PROGRESS row for (scope, key) ONLY if it is past `now` (an
   * abandoned holder). Scoped by expiry so a racing reclaimer that already replaced it with a
   * fresh row is left untouched — that racer's re-INSERT then wins and this caller loses on the
   * unique index instead of two handlers running. Returns how many rows were removed.
   */
  deleteExpiredInProgress(scope: string, key: string, now: Date): Promise<number>;

  /**
   * `expires_at` is the ONLY legal condition here. Adding `status = 'COMPLETED'`, or excluding it,
   * would break the retry guarantee: a COMPLETED row inside its TTL is the frozen response a
   * legitimate retry replays, and removing it early lets that retry create a second order.
   */
  deleteExpired(now: Date, limit: number): Promise<number>;
}
