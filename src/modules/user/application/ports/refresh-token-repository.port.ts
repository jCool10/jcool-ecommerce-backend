import type { Role } from '@shared/rbac';

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
  presentedTokenHash: string;
  newTokenHash: string;
  newExpiresAt: Date;
}

/**
 * Outcome of an atomic rotation: `rotated` carries the owner's `role`+`tokenEpoch` (same-tx) for the
 * successor token; `reuse` means a retired token was replayed (family revoked), `replaced` = theft signal.
 * See docs/engineering-notes.md (Auth — Refresh token rotation & reuse detection).
 */
export type RotateOutcome =
  | { status: 'rotated'; userId: string; role: Role; tokenEpoch: number }
  | { status: 'invalid' }
  | { status: 'reuse'; userId: string; familyId: string; replaced: boolean };

/** One active session (a token family) shown to the account owner; `id` is the familyId. */
export interface ActiveSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export interface RefreshTokenRepositoryPort {
  create(input: CreateRefreshTokenInput): Promise<void>;

  /** Atomically rotate the presented token or detect reuse (row-locked: concurrent rotations can't both win). */
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome>;

  /** Revoke the presented token if it belongs to `userId`; no-op otherwise. */
  revoke(userId: string, tokenHash: string): Promise<void>;

  /** Revoke every live refresh token for a user — the global session kill. */
  revokeAllForUser(userId: string): Promise<void>;

  /** The user's active sessions, newest first; `currentTokenHash` flags the caller's own. */
  listActiveSessions(userId: string, currentTokenHash: string | null): Promise<ActiveSession[]>;

  /** Revoke one family owned by `userId`; false if unknown or not theirs (so the caller can 404). */
  revokeFamily(userId: string, familyId: string): Promise<boolean>;

  /**
   * DELETE tokens that expired before `expiredBefore` **and were never revoked**, plus tokens
   * revoked before `revokedBefore`. At most `limit` rows; returns how many went (retention sweep).
   *
   * Two cutoffs because the arms answer to different clocks: expiry is age, revocation is evidence.
   * A revoked row is what lets {@link rotate} say "this token was retired and has come back" — the
   * reuse detection the rotation scheme is built on — so it gets a much longer grace, floored at 30
   * days in `env.validation`.
   *
   * The `revoked_at IS NULL` qualifier on the expiry arm is what makes that floor real. Every
   * rotation revokes its predecessor, so a rotated token carries both an expiry and a revocation,
   * and {@link rotate} checks revoked/replaced *before* expiry so a retired token still reads as
   * reuse. Without the qualifier the expiry arm would collect those rows on the short clock and the
   * 30-day guarantee would be fiction for every token that was ever rotated.
   */
  deleteCollectable(expiredBefore: Date, revokedBefore: Date, limit: number): Promise<number>;
}
