import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailVerificationMessage, MailerPort, PasswordResetMessage } from '../application/ports';

/** Default mail transport that logs the message on a dedicated `Mailer` context instead of hitting SMTP — a real sink (not a mock), replaceable by a production SMTP adapter behind {@link MailerPort} with no caller change. Outside development the link is logged without its token: this is the only MailerPort wired today, so a deploy with no SMTP adapter would otherwise print live account-takeover credentials to stdout. */
@Injectable()
export class LogMailer implements MailerPort {
  private readonly logger = new Logger('Mailer');
  private readonly publicUrl: string;
  private readonly includeToken: boolean;

  constructor(config: ConfigService) {
    this.publicUrl = config.get<string>('app.publicUrl') ?? 'http://localhost:3000';
    // Printing the whole link is the entire point of this sink locally — it is how a developer
    // finishes a signup with no SMTP. Anywhere else it is a single-use credential written in
    // plaintext to a log platform, readable by anyone with log access, which is a worse exposure
    // than the email it stands in for.
    this.includeToken = config.get<string>('app.env') === 'development';
  }

  sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    const verifyUrl = this.link('/auth/verify-email', message.token);
    this.emit({ mail: 'email_verification', to: message.to, verifyUrl });
    return Promise.resolve();
  }

  sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    const resetUrl = this.link('/auth/reset-password', message.token);
    this.emit({ mail: 'password_reset', to: message.to, resetUrl });
    return Promise.resolve();
  }

  private link(path: string, token: string): string {
    const url = `${this.publicUrl}${path}`;
    return this.includeToken ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  // The line still records that a link was issued, to whom, and for what — everything an
  // investigation needs — while the token itself stays out of the log outside development.
  private emit(fields: Record<string, string>): void {
    this.logger.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  }
}
