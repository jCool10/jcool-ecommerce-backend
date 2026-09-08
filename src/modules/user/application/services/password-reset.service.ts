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

export interface ResetRecipient {
  id: string;
  email: string;
}

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

  async issueAndSend(recipient: ResetRecipient): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');

    await this.tokens.invalidateAllForUser(recipient.id);
    await this.tokens.create({
      userId: recipient.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + this.ttlMs),
    });
    // Not awaited, for the reason spelled out in EmailVerificationService: forgot-password answers 202
    // for any address, and a mail server's latency on the existing-account branch alone would hand back
    // that difference. The catch is only what `void` needs.
    void this.mailer.sendPasswordReset({ to: recipient.email, token: rawToken }).catch(() => undefined);

    this.audit.record({
      event: 'password.reset_requested',
      outcome: 'success',
      userId: recipient.id,
      email: recipient.email,
    });
  }

  /** One generic 400 covers invalid, expired and already-used tokens alike. */
  async reset(rawToken: string, newPassword: string): Promise<{ userId: string }> {
    const outcome = await this.tokens.consume(sha256Hex(rawToken));
    if (outcome.status === 'invalid') {
      throw new BadRequestException('Invalid or expired password-reset token');
    }

    const passwordHash = await this.hasher.hash(newPassword);
    // A reset is a compromise response, so every session goes. Revoking first fails safe: a crash
    // leaves the old password with the sessions gone, never the reverse. Still open — the attacker
    // holds that old password, and a login racing the window INSERTs a refresh family after
    // revokeAllForUser has passed, which no later write revokes. Closing it needs one transaction.
    await this.sessions.revokeAll(outcome.userId);
    await this.users.updatePassword(outcome.userId, passwordHash);

    return { userId: outcome.userId };
  }
}
