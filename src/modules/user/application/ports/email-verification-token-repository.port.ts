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
}
