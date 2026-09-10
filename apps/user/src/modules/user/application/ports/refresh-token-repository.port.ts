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
 * `rotated` carries the owner's claims — `role`, `email`, `tokenEpoch` — read in the same
 * transaction, for the successor token; `reuse` means a retired token was replayed and the family is
 * now revoked, `replaced` = theft signal.
 */
export type RotateOutcome =
  | { status: 'rotated'; userId: string; role: Role; email: string; tokenEpoch: number }
  | { status: 'invalid' }
  | { status: 'reuse'; userId: string; familyId: string; replaced: boolean };

/** One session as shown to the account owner; `id` is the familyId. */
export interface ActiveSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export interface RefreshTokenRepositoryPort {
  create(input: CreateRefreshTokenInput): Promise<void>;

  /** Row-locked, so concurrent rotations can't both win. */
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome>;

  /** No-op when the token does not belong to `userId`. */
  revoke(userId: string, tokenHash: string): Promise<void>;

  revokeAllForUser(userId: string): Promise<void>;

  /** Newest first; `currentTokenHash` flags the caller's own. */
  listActiveSessions(userId: string, currentTokenHash: string | null): Promise<ActiveSession[]>;

  /** False if the family is unknown or not theirs (so the caller can 404). */
  revokeFamily(userId: string, familyId: string): Promise<boolean>;

  /**
   * Retention sweep: deletes tokens expired before `expiredBefore` **and never revoked**, plus
   * tokens revoked before `revokedBefore`, at most `limit`, returning how many went.
   *
   * Two cutoffs because the arms answer to different clocks: expiry is age, revocation is evidence.
   * A revoked row is what lets {@link rotate} say "this token was retired and has come back", so it
   * gets a much longer grace, floored at 30 days in `env.validation`. The `revoked_at IS NULL`
   * qualifier on the expiry arm is what makes that floor real: every rotation revokes its
   * predecessor, so a rotated token carries both an expiry and a revocation, and {@link rotate}
   * checks revoked/replaced *before* expiry. Without the qualifier the expiry arm would collect
   * those rows on the short clock and the 30-day guarantee would be fiction after any rotation.
   */
  deleteCollectable(expiredBefore: Date, revokedBefore: Date, limit: number): Promise<number>;
}
