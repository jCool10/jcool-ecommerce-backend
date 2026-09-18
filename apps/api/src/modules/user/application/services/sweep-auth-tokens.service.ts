import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  PASSWORD_RESET_TOKEN_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepositoryPort,
  type PasswordResetTokenRepositoryPort,
  type RefreshTokenRepositoryPort,
} from '../ports';

const DAY_MS = 86_400_000;

/**
 * One file, THREE registered sweeps. `name` is both the metric label and the fault-isolation unit,
 * so a single `auth-tokens` sweep could not say which table stopped being collected, and one failure
 * would take the other two down with it. See {@link RefreshTokenRepositoryPort.deleteCollectable}
 * for why the refresh table is kept an order of magnitude longer than the single-use ones.
 */
@Injectable()
export class SweepAuthTokensService implements OnModuleInit {
  private readonly tokenGraceMs: number;
  private readonly refreshGraceMs: number;

  constructor(
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY)
    private readonly emailVerification: EmailVerificationTokenRepositoryPort,
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY)
    private readonly passwordReset: PasswordResetTokenRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refresh: RefreshTokenRepositoryPort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.tokenGraceMs = config.getOrThrow<number>('retention.authTokenGraceDays') * DAY_MS;
    this.refreshGraceMs = config.getOrThrow<number>('retention.refreshTokenGraceDays') * DAY_MS;
  }

  onModuleInit(): void {
    for (const sweep of this.sweeps()) this.registry.register(sweep);
  }

  /** Exposed so a test can drive one rule at a time without a scheduler or a registry. */
  sweeps(): readonly RetentionSweep[] {
    return [
      {
        name: 'auth-tokens:email-verification',
        sweep: (batchSize) => this.emailVerification.deleteSpentBefore(this.tokenCutoff(), batchSize),
      },
      {
        name: 'auth-tokens:password-reset',
        sweep: (batchSize) => this.passwordReset.deleteSpentBefore(this.tokenCutoff(), batchSize),
      },
      {
        name: 'auth-tokens:refresh',
        sweep: (batchSize) =>
          this.refresh.deleteCollectable(this.tokenCutoff(), new Date(Date.now() - this.refreshGraceMs), batchSize),
      },
    ];
  }

  // Per tick, not at construction — a long-lived process would otherwise keep sweeping against the
  // cutoff it booted with.
  private tokenCutoff(): Date {
    return new Date(Date.now() - this.tokenGraceMs);
  }
}
