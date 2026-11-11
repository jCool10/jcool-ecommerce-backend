import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { MAIL_TRANSPORT, type MailMessage, type MailTransportPort } from '@jcool/platform/mail';
import type { DomainEventJob, PostCommitEffect } from '@jcool/messaging';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { USER_CONTACT, type UserContactPort } from '../../application/ports/user-contact.port';
import { formatTotal, recipientOf, sendOnceAfterCommit } from './order-mail';

const LOG_CONTEXT = 'OrderRefundedMailHandler';

/** The buyer's refund notice, on the confirmation mail's terms: at most once, a failed send counted. */
@Injectable()
export class OrderRefundedMailHandler {
  constructor(
    @Inject(USER_CONTACT) private readonly userContact: UserContactPort,
    @Inject(MAIL_TRANSPORT) private readonly mailTransport: MailTransportPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async prepare(job: DomainEventJob): Promise<PostCommitEffect> {
    const { orderId, email } = await recipientOf(job, this.userContact);
    const { mailTransport, metrics, logger } = this;
    return sendOnceAfterCommit({ mailTransport, metrics, logger }, buildMessage(orderId, email, job.payload), {
      kind: 'order_refunded',
      context: { orderId, messageId: job.outboxId },
      message: 'refund mail was not delivered and will not be retried',
    });
  }
}

function buildMessage(orderId: string, to: string, payload: Record<string, unknown>): MailMessage {
  const total = formatTotal(payload.totalAmountMinor, payload.currency);
  return {
    to,
    subject: 'Your refund has been issued',
    text: [
      'We have refunded your payment. Your bank may take a few days to show it.',
      '',
      `Order: ${orderId}`,
      ...(total ? [`Refunded: ${total}`] : []),
      '',
    ].join('\n'),
  };
}
