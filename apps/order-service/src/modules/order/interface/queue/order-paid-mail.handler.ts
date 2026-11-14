import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { MAIL_TRANSPORT, type MailMessage, type MailTransportPort } from '@jcool/platform/mail';
import type { DomainEventJob, PostCommitEffect } from '@jcool/messaging';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { USER_CONTACT, type UserContactPort } from '../../application/ports/user-contact.port';
import { formatTotal, recipientOf, sendOnceAfterCommit } from './order-mail';

const LOG_CONTEXT = 'OrderPaidMailHandler';

/**
 * Composed before the consumer's transaction and sent after it commits. The address can come from
 * the user-service, and that call must not hold a pool connection; the SMTP call must not either,
 * and a breaker timeout cannot cancel a message already on the wire — the redelivery would send it
 * again while the first is still flying.
 */
@Injectable()
export class OrderPaidMailHandler {
  constructor(
    @Inject(USER_CONTACT) private readonly userContact: UserContactPort,
    @Inject(MAIL_TRANSPORT) private readonly mailTransport: MailTransportPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** A directory that could not answer throws through, so the delivery goes back on its retry ladder. */
  async prepare(job: DomainEventJob): Promise<PostCommitEffect> {
    const { orderId, email } = await recipientOf(job, this.userContact);
    const { mailTransport, metrics, logger } = this;
    return sendOnceAfterCommit({ mailTransport, metrics, logger }, buildMessage(orderId, email, job.payload), {
      kind: 'order_paid',
      context: { orderId, messageId: job.outboxId },
      message: 'order confirmation mail was not delivered and will not be retried',
    });
  }
}

function buildMessage(orderId: string, to: string, payload: Record<string, unknown>): MailMessage {
  const total = formatTotal(payload.totalAmountMinor, payload.currency);
  return {
    to,
    subject: 'Your order is confirmed',
    text: ['We have received your payment.', '', `Order: ${orderId}`, ...(total ? [`Total: ${total}`] : []), ''].join(
      '\n',
    ),
  };
}
