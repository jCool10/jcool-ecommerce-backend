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

  /** Atomically spend the token only if still live (one conditional UPDATE: concurrent submits can't both consume). */
  consume(tokenHash: string): Promise<ConsumePasswordResetOutcome>;

  /** Consume every live token for a user — called before issuing a fresh one. */
  invalidateAllForUser(userId: string): Promise<void>;

  /**
   * DELETE the tokens that can no longer be spent — expired, or already consumed — once they are
   * older than `cutoff`. At most `limit` rows; returns how many went (retention sweep). Same
   * reasoning as the email-verification twin.
   */
  deleteSpentBefore(cutoff: Date, limit: number): Promise<number>;
}
