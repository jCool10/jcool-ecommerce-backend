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

  /** One conditional UPDATE, so concurrent submits can't both consume the token. */
  consume(tokenHash: string): Promise<ConsumeEmailVerificationOutcome>;

  /** Called before issuing a fresh token on resend. */
  invalidateAllForUser(userId: string): Promise<void>;

  /**
   * Retention sweep: deletes rows expired or already consumed before `cutoff`, at most `limit`,
   * returning how many went. Safe because `consume` is a conditional UPDATE guarded by the same
   * two conditions — a row matching this predicate could not have been consumed by anyone anyway.
   */
  deleteSpentBefore(cutoff: Date, limit: number): Promise<number>;
}
