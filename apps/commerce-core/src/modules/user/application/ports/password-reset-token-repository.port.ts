export const PASSWORD_RESET_TOKEN_REPOSITORY = Symbol('PASSWORD_RESET_TOKEN_REPOSITORY');

export interface CreatePasswordResetTokenInput {
  userId: string;
  /** SHA-256 hex of the opaque token — the raw token is never stored. */
  tokenHash: string;
  expiresAt: Date;
}

export type ConsumePasswordResetOutcome = { status: 'consumed'; userId: string } | { status: 'invalid' };

export interface PasswordResetTokenRepositoryPort {
  create(input: CreatePasswordResetTokenInput): Promise<void>;

  /** One conditional UPDATE, so concurrent submits can't both consume the token. */
  consume(tokenHash: string): Promise<ConsumePasswordResetOutcome>;

  /** Called before issuing a fresh token. */
  invalidateAllForUser(userId: string): Promise<void>;

  /**
   * Retention sweep: deletes rows expired or already consumed before `cutoff`, at most `limit`,
   * returning how many went. Same safety reasoning as the email-verification twin.
   */
  deleteSpentBefore(cutoff: Date, limit: number): Promise<number>;
}
