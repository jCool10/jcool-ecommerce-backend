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
}
