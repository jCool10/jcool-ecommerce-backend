import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { durationToMs } from '../duration-to-ms';
import { sha256Hex } from '../sha256-hex';
import { AUTH_AUDIT, type AuthAuditPort } from '../ports/auth-audit.port';
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepositoryPort,
} from '../ports/email-verification-token-repository.port';
import { MAILER, type MailerPort } from '../ports/mailer.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';

/** Minimal recipient shape needed to issue + send a verification token. */
export interface VerificationRecipient {
  id: string;
  email: string;
}

/** Owns the email-verification token lifecycle (shared by register + resend): issue-and-send a single-use token, then spend it to mark the address verified. */
@Injectable()
export class EmailVerificationService {
  private readonly ttlMs: number;

  constructor(
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY)
    private readonly tokens: EmailVerificationTokenRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
    config: ConfigService,
  ) {
    this.ttlMs = durationToMs(config.getOrThrow<string>('auth.emailVerificationTtl'));
  }

  /** Issue a fresh single-use token and email it; any earlier unconsumed token is invalidated first. */
  async issueAndSend(recipient: VerificationRecipient): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');

    await this.tokens.invalidateAllForUser(recipient.id);
    await this.tokens.create({
      userId: recipient.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + this.ttlMs),
    });
    await this.mailer.sendEmailVerification({ to: recipient.email, token: rawToken });

    this.audit.record({
      event: 'email.verification_sent',
      outcome: 'success',
      userId: recipient.id,
      email: recipient.email,
    });
  }

  /** Spend the token and mark the owner's email verified; generic 400 on any invalid/expired/used token. */
  async verify(rawToken: string): Promise<{ userId: string }> {
    const outcome = await this.tokens.consume(sha256Hex(rawToken));
    if (outcome.status === 'invalid') {
      throw new BadRequestException('Invalid or expired verification token');
    }
    await this.users.markEmailVerified(outcome.userId);
    return { userId: outcome.userId };
  }
}
