import { createTransport, type Transporter } from 'nodemailer';
import type { OutboundCall } from '@shared/resilience';
import type { MailMessage, MailTransportPort } from './mail-transport.port';

/** Metric label, so it stays a fixed name rather than anything derived per call. */
export const MAIL_BREAKER = 'mail';

export interface SmtpMailOptions {
  /** Connection URL, e.g. `smtp://user:pass@host:587`. */
  url: string;
  /** Envelope sender for every message this transport sends. */
  from: string;
  breaker: OutboundCall;
  /** Budget for each socket phase. Required: nodemailer's own defaults run to ten minutes. */
  timeoutMs: number;
  /** Test seam: a nodemailer-shaped transporter, so the send path is covered without a server. */
  transporter?: Pick<Transporter, 'sendMail'>;
}

/**
 * Real SMTP behind its own circuit breaker.
 *
 * Its own, not the payment gateway's: a mail server is slower by nature and its outage stops nobody
 * buying anything, so sharing a breaker would let a sulking relay open the circuit on checkout.
 */
export class SmtpMailTransport implements MailTransportPort {
  private readonly transporter: Pick<Transporter, 'sendMail'>;
  private readonly from: string;
  private readonly breaker: OutboundCall;

  constructor(options: SmtpMailOptions) {
    // Per phase, not per send: the breaker bounds what the caller waits for, these bound what the
    // socket holds. Without them a relay that accepts the connection and then stops talking keeps
    // the socket alive long after the breaker gave up on it — a timeout cannot cancel a request
    // already on the wire.
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
