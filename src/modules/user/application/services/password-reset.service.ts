import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { durationToMs, sha256Hex } from '..';
import {
  AUTH_AUDIT,
  type AuthAuditPort,
  MAILER,
  type MailerPort,
  PASSWORD_HASHER,
  type PasswordHasherPort,
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepositoryPort,
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../ports';
import { SessionService } from './session.service';

/** Minimal recipient shape needed to issue + send a password-reset token. */
export interface ResetRecipient {
  id: string;
  email: string;
}

/** Owns the password-reset token lifecycle: issue-and-send a single-use token, then spend it to set a new password and revoke every session. */
@Injectable()
export class PasswordResetService {
  private readonly ttlMs: number;

  constructor(
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY)
    private readonly tokens: PasswordResetTokenRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly sessions: SessionService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
    config: ConfigService,
  ) {
    this.ttlMs = durationToMs(config.getOrThrow<string>('auth.passwordResetTtl'));
  }

  /** Issue a fresh single-use reset token and email it; any earlier unconsumed token is invalidated first. */
  async issueAndSend(recipient: ResetRecipient): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');

    await this.tokens.invalidateAllForUser(recipient.id);
    await this.tokens.create({
      userId: recipient.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + this.ttlMs),
    });
    // Not awaited, for the reason spelled out in EmailVerificationService: forgot-password answers
    // 202 for any address, and a mail server's latency on the existing-account branch alone would
    // hand back that difference. The catch is only the unhandledRejection guard `void` needs.
    void this.mailer.sendPasswordReset({ to: recipient.email, token: rawToken }).catch(() => undefined);

    this.audit.record({
      event: 'password.reset_requested',
      outcome: 'success',
      userId: recipient.id,
      email: recipient.email,
    });
  }

  /** Spend the token, set the new password, revoke all sessions; generic 400 on any invalid/expired/used token. */
  async reset(rawToken: string, newPassword: string): Promise<{ userId: string }> {
    const outcome = await this.tokens.consume(sha256Hex(rawToken));
    if (outcome.status === 'invalid') {
      throw new BadRequestException('Invalid or expired password-reset token');
    }

    const passwordHash = await this.hasher.hash(newPassword);
    await this.users.updatePassword(outcome.userId, passwordHash);
    // A reset is a compromise response — sign out every session (refresh + access via the epoch bump).
    await this.sessions.revokeAll(outcome.userId);

    return { userId: outcome.userId };
  }
}
