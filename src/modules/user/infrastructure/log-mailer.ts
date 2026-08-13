import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailVerificationMessage, MailerPort, PasswordResetMessage } from '../application/ports/mailer.port';

/**
 * Default mail transport: logs the message on a dedicated `Mailer` context instead of
 * hitting SMTP. A real sink (not a mock), so the full flow runs without mail infra; a
 * production SMTP adapter can replace it behind {@link MailerPort} with no caller change.
 */
@Injectable()
export class LogMailer implements MailerPort {
  private readonly logger = new Logger('Mailer');
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    this.publicUrl = config.get<string>('app.publicUrl') ?? 'http://localhost:3000';
  }

  sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    const verifyUrl = `${this.publicUrl}/auth/verify-email?token=${encodeURIComponent(message.token)}`;
    this.logger.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        mail: 'email_verification',
        to: message.to,
        verifyUrl,
      }),
    );
    return Promise.resolve();
  }

  sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    const resetUrl = `${this.publicUrl}/auth/reset-password?token=${encodeURIComponent(message.token)}`;
    this.logger.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        mail: 'password_reset',
        to: message.to,
        resetUrl,
      }),
    );
    return Promise.resolve();
  }
}
