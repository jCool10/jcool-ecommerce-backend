import type {
  ConsumeEmailVerificationOutcome,
  CreateEmailVerificationTokenInput,
  EmailVerificationTokenRepositoryPort,
  PasswordResetTokenRepositoryPort,
} from '../application/ports';

/** Both single-use token ports share one shape, so one fake serves email verification and password reset. */
export class FakeSingleUseTokenRepository
  implements EmailVerificationTokenRepositoryPort, PasswordResetTokenRepositoryPort
{
  readonly created: CreateEmailVerificationTokenInput[] = [];
  /** Each supersede call, with how many tokens had been created when it ran. */
  readonly superseded: Array<{ userId: string; keptHash: string; afterCreates: number }> = [];
  consumeResult: ConsumeEmailVerificationOutcome = { status: 'invalid' };
  consumedHash?: string;
  createError?: Error;

  create(input: CreateEmailVerificationTokenInput): Promise<void> {
    if (this.createError) return Promise.reject(this.createError);
    this.created.push(input);
    return Promise.resolve();
  }

  consume(tokenHash: string): Promise<ConsumeEmailVerificationOutcome> {
    this.consumedHash = tokenHash;
    return Promise.resolve(this.consumeResult);
  }

  invalidateOthersForUser(userId: string, keptHash: string): Promise<void> {
    this.superseded.push({ userId, keptHash, afterCreates: this.created.length });
    return Promise.resolve();
  }

  deleteSpentBefore(): Promise<number> {
    return Promise.resolve(0);
  }
}
