/**
 * Port for refresh-token session records. The adapter owns the atomic mutations
 * (create, rotate-or-detect-reuse, revoke) and reports a typed outcome; the use
 * case owns what each outcome means.
 */

import type { Role } from '../../../../shared/rbac/role.enum';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface CreateRefreshTokenInput {
  userId: string;
  /** SHA-256 hex of the opaque token — the raw token is never stored. */
  tokenHash: string;
  /** Groups every token derived from one login session (reuse detection). */
  familyId: string;
  expiresAt: Date;
}

export interface RotateRefreshTokenInput {
  /** SHA-256 hex of the refresh token the client presented. */
  presentedTokenHash: string;
  /** SHA-256 hex of the freshly generated successor token (persisted on success). */
  newTokenHash: string;
  /** Expiry for the successor token. */
  newExpiresAt: Date;
}

/**
 * Result of an atomic rotation attempt:
 * - `rotated` — presented token was the live leaf; carries `userId` + the owner's
 *   current `role` (read in the same transaction) to sign the new access token.
 * - `invalid` — token unknown or expired (merged into one generic 401).
 * - `reuse` — token already revoked/rotated → whole family revoked; `replaced`
 *   marks the strong theft signal (superseded token replayed) vs a benign replay.
 */
export type RotateOutcome =
  | { status: 'rotated'; userId: string; role: Role }
  | { status: 'invalid' }
  | { status: 'reuse'; userId: string; familyId: string; replaced: boolean };

export interface RefreshTokenRepositoryPort {
  /** Persist a new refresh-token record. */
  create(input: CreateRefreshTokenInput): Promise<void>;

  /**
   * Atomically rotate the presented token or detect reuse. One transaction with
   * a row lock so two concurrent rotations can't both succeed (loser → reuse).
   */
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome>;

  /** Revoke the presented token if it belongs to `userId`. Idempotent no-op otherwise. */
  revoke(userId: string, tokenHash: string): Promise<void>;
}
