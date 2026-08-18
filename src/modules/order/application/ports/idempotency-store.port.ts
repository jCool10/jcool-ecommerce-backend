import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// Idempotency-key store port; the Drizzle adapter implements it in infrastructure/.
// Keeps the application free of drizzle-orm/schema. The unique (scope, key) index —
// not an application if-check — is the concurrency backstop: a racing duplicate loses
// the INSERT rather than creating a second order.
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

  /** The current record for (scope, key), or null. Used to branch replay / 409 / 422. */
  findByScopeAndKey(scope: string, key: string): Promise<IdempotencyRecord | null>;

  /**
   * Freeze the result: status → COMPLETED with the response to replay. Pass `tx` to join the
   * checkout transaction so the key commits atomically with the order + reservation; omit it
   * to run standalone (e.g. caching a business 4xx that has no order).
   */
  markCompleted(input: MarkCompletedInput, tx?: DrizzleTx): Promise<void>;

  /**
   * Remove an IN_PROGRESS row so the client can retry — called when the handler failed with an
   * unexpected error (the deterministic result was never recorded). Pass `tx` to run inside a
   * unit of work; omit to run standalone.
   */
  deleteInProgress(scope: string, key: string, tx?: DrizzleTx): Promise<void>;

  /** DELETE WHERE expires_at < now (TTL sweep). Returns how many rows were reclaimed. */
  deleteExpired(now: Date): Promise<number>;
}
