import { createTransport, type Transporter } from 'nodemailer';
import type { OutboundCall } from '@shared/resilience';
import type { MailMessage, MailTransportPort } from './mail-transport.port';

/** Metric label; a fixed name rather than anything derived per call. */
export const MAIL_BREAKER = 'mail';

export interface SmtpMailOptions {
  url: string;
  from: string;
  breaker: OutboundCall;
  /** Budget for each socket phase. Required: nodemailer's own defaults run to ten minutes. */
  timeoutMs: number;
  /** Test seam, so the send path is covered without a server. */
  transporter?: Pick<Transporter, 'sendMail'>;
}

/**
 * Its own breaker, not the payment gateway's: a mail server is slower by nature and its outage stops
 * nobody buying anything, so sharing one would let a sulking relay open the circuit on checkout.
 */
export class SmtpMailTransport implements MailTransportPort {
  private readonly transporter: Pick<Transporter, 'sendMail'>;
  private readonly from: string;
  private readonly breaker: OutboundCall;

  constructor(options: SmtpMailOptions) {
    // Per phase, not per send: a breaker timeout cannot cancel a request already on the wire, so
    // without these a relay that accepts the connection and then stops talking keeps the socket
    // alive long after the breaker gave up on it.
    this.transporter =
      options.transporter ??
      createTransport({
        url: options.url,
        connectionTimeout: options.timeoutMs,
        greetingTimeout: options.timeoutMs,
        socketTimeout: options.timeoutMs,
      });
    this.from = options.from;
    this.breaker = options.breaker;
  }

  async sendMail(message: MailMessage): Promise<void> {
    await this.breaker.run(() => this.transporter.sendMail({ from: this.from, ...message }));
  }
}
