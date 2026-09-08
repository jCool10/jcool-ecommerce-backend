import { Injectable, Logger } from '@nestjs/common';
import type { MailMessage, MailTransportPort } from './mail-transport.port';

/**
 * Records that a message was sent, never what it said: bodies carry redeemable verification and
 * password-reset tokens, and a central log is read by far more people than the recipient's inbox.
 * Run Mailpit (docker compose) to read an actual link locally.
 */
@Injectable()
export class LogMailTransport implements MailTransportPort {
  private readonly logger = new Logger('Mailer');

  sendMail(message: MailMessage): Promise<void> {
    this.logger.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        to: message.to,
        subject: message.subject,
        bodyChars: message.text.length,
      }),
    );
    return Promise.resolve();
  }
}
