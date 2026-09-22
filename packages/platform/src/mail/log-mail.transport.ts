import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { MailMessage, MailTransportPort } from './mail-transport.port';

const LOG_CONTEXT = 'Mailer';

/**
 * Records that a message was sent, never what it said: bodies carry redeemable verification and
 * password-reset tokens, and a central log is read by far more people than the recipient's inbox.
 * Run Mailpit (docker compose) to read an actual link locally.
 */
@Injectable()
export class LogMailTransport implements MailTransportPort {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
  }

  sendMail(message: MailMessage): Promise<void> {
    // Fields, not a JSON.stringify'd blob: the recipient and subject are what a support ticket is
    // searched by, and a stringified payload makes them a substring rather than a queryable key.
    this.logger.info({ to: message.to, subject: message.subject, bodyChars: message.text.length }, 'mail sent');
    return Promise.resolve();
  }
}
