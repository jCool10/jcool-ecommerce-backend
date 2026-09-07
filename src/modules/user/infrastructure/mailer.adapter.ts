import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAIL_TRANSPORT, type MailMessage, type MailTransportPort } from '@shared/mail/mail-transport.port';
import { METRICS, type MailKind, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { EmailVerificationMessage, MailerPort, PasswordResetMessage } from '../application/ports';

const LOG_CONTEXT = 'MailerAdapter';

/**
 * User's transactional mail: this context owns the wording and the links, the shared transport owns
 * delivery.
 *
 * Sent directly rather than through the outbox, unlike every other event here: the body carries a
 * raw redeemable token, and the outbox is jsonb in Postgres — where the token tables deliberately
 * keep only hashes.
 */
@Injectable()
export class MailerAdapter implements MailerPort {
  private readonly logger = new Logger(LOG_CONTEXT);
  private readonly publicUrl: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransportPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
  ) {
    this.publicUrl = config.get<string>('app.publicUrl') ?? 'http://localhost:3000';
  }

  sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    return this.send('email_verification', {
      to: message.to,
      subject: 'Verify your email address',
      text: `Confirm your address to finish creating your account:\n\n${this.link('/auth/verify-email', message.token)}\n`,
    });
  }

  sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    return this.send('password_reset', {
      to: message.to,
      subject: 'Reset your password',
      text: `Choose a new password here — ignore this message if you did not ask for one:\n\n${this.link('/auth/reset-password', message.token)}\n`,
    });
  }

  private link(path: string, token: string): string {
    return `${this.publicUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * A failed send is counted and logged, never thrown. The two enumeration-safe routes answer 202
   * whether or not the address exists, so letting a dead mail server turn the existing-account
   * branch into a 500 would hand back exactly the answer they refuse to give.
   */
  private async send(kind: MailKind, message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail(message);
    } catch (error) {
      this.metrics.recordMailSendFailure(kind);
      // The recipient is in the audit trail already; the body never is, since it holds the token.
      this.logger.error(`Sending ${kind} mail failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
