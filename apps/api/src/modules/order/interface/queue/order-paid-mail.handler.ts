import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { MAIL_TRANSPORT, type MailMessage, type MailTransportPort } from '@jcool/platform/mail';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob, PostCommitEffect } from '@shared/messaging/queue/domain-event.job';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { USER_CONTACT, type UserContactPort } from '../../application/ports/user-contact.port';

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
    @Inject(USER_CONTACT) private readonly contacts: UserContactPort,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransportPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** A directory that could not answer throws through, so the delivery goes back on its retry ladder. */
  async prepare(job: DomainEventJob): Promise<PostCommitEffect> {
    const { orderId, userId } = job.payload;
    // Permanent: the payload is byte-identical on every redelivery, so retrying changes nothing.
    if (typeof orderId !== 'string' || typeof userId !== 'string') {
      throw new PermanentError(`order.paid without an orderId/userId to confirm (message ${job.outboxId})`);
    }

    // The event deliberately carries no email address: the outbox is jsonb in Postgres, and a
    // deleted account must not leave its address behind in it.
    const user = await this.contacts.find(userId, new Date(job.occurredAt));
    if (!user) {
      throw new PermanentError(`order.paid for order ${orderId} names a user that no longer exists`);
    }

    const message = buildMessage(orderId, user.email, job.payload);
    return async () => {
      try {
        await this.transport.sendMail(message);
      } catch (error: unknown) {
        this.metrics.recordMailSendFailure('order_paid');
        this.logger.error(
          { orderId, messageId: job.outboxId, err: toError(error) },
          'order confirmation mail was not delivered and will not be retried',
        );
      }
    };
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

/** Null rather than a guess when the payload cannot be read: a wrong total is worse than none. */
function formatTotal(amountMinor: unknown, currency: unknown): string | null {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  // Minor units per major unit read off the currency itself — 1 for VND, 100 for USD.
  return format.format(amountMinor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 0));
}
