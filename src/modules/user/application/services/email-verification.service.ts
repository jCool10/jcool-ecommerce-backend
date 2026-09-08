import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { durationToMs, sha256Hex } from '..';
import {
  AUTH_AUDIT,
  type AuthAuditPort,
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepositoryPort,
  MAILER,
  type MailerPort,
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../ports';

export interface VerificationRecipient {
  id: string;
  email: string;
}

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

  async issueAndSend(recipient: VerificationRecipient): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');

    await this.tokens.invalidateAllForUser(recipient.id);
    await this.tokens.create({
      userId: recipient.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + this.ttlMs),
    });
    // Not awaited: this also serves the enumeration-safe routes, where waiting on a mail server would
    // make the existing-account branch measurably slower than the unknown-address one — the same answer,
    // told by the clock. The mailer never rejects (see MailerAdapter); the catch is only what `void` needs.
    void this.mailer.sendEmailVerification({ to: recipient.email, token: rawToken }).catch(() => undefined);

    this.audit.record({
      event: 'email.verification_sent',
      outcome: 'success',
      userId: recipient.id,
      email: recipient.email,
    });
  }

  /** One generic 400 covers invalid, expired and already-used tokens alike. */
  async verify(rawToken: string): Promise<{ userId: string }> {
    const outcome = await this.tokens.consume(sha256Hex(rawToken));
    if (outcome.status === 'invalid') {
      throw new BadRequestException('Invalid or expired verification token');
    }
    await this.users.markEmailVerified(outcome.userId);
    return { userId: outcome.userId };
  }
}
