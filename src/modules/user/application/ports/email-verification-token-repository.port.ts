export const EMAIL_VERIFICATION_TOKEN_REPOSITORY = Symbol('EMAIL_VERIFICATION_TOKEN_REPOSITORY');

export interface CreateEmailVerificationTokenInput {
  userId: string;
  /** SHA-256 hex of the opaque token — the raw token is never stored. */
  tokenHash: string;
  expiresAt: Date;
}

export type ConsumeEmailVerificationOutcome = { status: 'consumed'; userId: string } | { status: 'invalid' };

export interface EmailVerificationTokenRepositoryPort {
  create(input: CreateEmailVerificationTokenInput): Promise<void>;

  /** Atomically spend the token only if still live (one conditional UPDATE: concurrent submits can't both consume). */
  consume(tokenHash: string): Promise<ConsumeEmailVerificationOutcome>;

  /** Consume every live token for a user — called before issuing a fresh one on resend. */
  invalidateAllForUser(userId: string): Promise<void>;

  /**
   * DELETE the tokens that can no longer be spent — expired, or already consumed — once they are
   * older than `cutoff`. At most `limit` rows; returns how many went (retention sweep).
   *
   * Safe to collect at all because `consume` is a conditional UPDATE guarded by the same two
   * conditions: a row matching this predicate could not have been consumed by anyone anyway.
   */
  deleteSpentBefore(cutoff: Date, limit: number): Promise<number>;
}
