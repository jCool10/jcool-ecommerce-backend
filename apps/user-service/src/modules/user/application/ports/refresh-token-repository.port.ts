import type { Role } from '@jcool/platform/rbac';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface CreateRefreshTokenInput {
  userId: string;
  /** SHA-256 hex of the opaque token — the raw token is never stored. */
  tokenHash: string;
  /** Groups every token derived from one login session (reuse detection). */
  familyId: string;
  expiresAt: Date;
  /** The stored hash the caller verified the password against. */
  verifiedPasswordHash: string;
}

/**
 * `created` carries the owner's `role`+`tokenEpoch` read where the session was stored, for its access
 * token. `credentials_changed` means the password was replaced (or the user is gone) since the caller
 * verified it, and nothing was stored.
 */
export type CreateRefreshTokenOutcome =
  { status: 'created'; role: Role; tokenEpoch: number } | { status: 'credentials_changed' };

export interface PasswordReplacement {
  newPasswordHash: string;
  /** The stored hash the caller verified the current password against; omitted by a reset. */
  verifiedPasswordHash?: string;
}

export interface RefreshTokenOwner {
  userId: string;
  /** The session the token belongs to; stays the same across every rotation. */
  familyId: string;
  /** False for a revoked, replaced or expired token: rotating it cannot mint a successor. */
  rotatable: boolean;
}

export interface RotateRefreshTokenInput {
  presentedTokenHash: string;
  /** The owner {@link RefreshTokenRepositoryPort.findOwner} saw; a locked row owned by anyone else is `invalid`. */
  expectedUserId: string;
  /** Minted before the transaction so the row lock is never held across a network call; null when not rotatable. */
  successorId: string | null;
  newTokenHash: string;
  newExpiresAt: Date;
  /** A token rotated away this recently answers `replayed`, not `reuse`. */
  reuseGraceMs: number;
}

/**
 * `rotated` carries the owner's `role`+`tokenEpoch` read in the same transaction, for the successor
 * token; `reuse` means a retired token was replayed and whatever was still live in the family got
 * revoked. `replaced` is true only when that revoke actually caught a live token — the theft signal —
 * so a repeat replay against an already-fully-revoked family reports `false` instead of re-alerting.
 * `replayed` is a token rotated away within the grace window (two tabs, a retried request): refused,
 * but nothing is revoked, because it is indistinguishable from a client that missed the response.
 */
export type RotateOutcome =
  | { status: 'rotated'; userId: string; role: Role; tokenEpoch: number }
  | { status: 'invalid' }
  | { status: 'reuse'; userId: string; familyId: string; replaced: boolean }
  | { status: 'replayed' };

/** One session as shown to the account owner; `id` is the familyId. */
export interface ActiveSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export interface RefreshTokenRepositoryPort {
  /** Under the user lock, and only while the stored hash still equals `verifiedPasswordHash`. */
  create(input: CreateRefreshTokenInput): Promise<CreateRefreshTokenOutcome>;

  /** Unlocked read; {@link rotate} re-reads the row under its lock. */
  findOwner(tokenHash: string): Promise<RefreshTokenOwner | null>;

  /** Row-locked, so concurrent rotations can't both win. */
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome>;

  /**
   * One transaction under the user lock: bumps `token_epoch`, stores `replacement`'s hash when given,
   * and revokes every live refresh token. Resolves to the new epoch, still to be published, or null
   * when nothing was written: the user is gone, or `verifiedPasswordHash` is no longer the stored hash.
   */
  revokeAllForUser(userId: string, replacement?: PasswordReplacement): Promise<number | null>;

  /** Newest first; `currentTokenHash` flags the caller's own. */
  listActiveSessions(userId: string, currentTokenHash: string | null): Promise<ActiveSession[]>;

  /**
   * Under the same user lock rotation takes, so a rotation in flight leaves no live successor.
   * False if the family is unknown or not theirs (so the caller can 404).
   */
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
