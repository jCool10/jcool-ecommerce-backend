import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { USER_FACADE, type UserFacade } from '@modules/user/application/public/user-facade.port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { MAIL_TRANSPORT, type MailMessage, type MailTransportPort } from '@shared/mail/mail-transport.port';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob, PostCommitEffect } from '@shared/messaging/queue/domain-event.job';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';

const LOG_CONTEXT = 'OrderPaidMailHandler';

/**
 * Composed inside the consumer's transaction but sent after it commits: an SMTP call held inside
 * would keep a pool connection for its whole round-trip, and a breaker timeout cannot cancel a
 * message already on the wire — the redelivery would send it again while the first is still flying.
 */
@Injectable()
export class OrderPaidMailHandler {
  constructor(
    @Inject(USER_FACADE) private readonly users: UserFacade,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransportPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {}

  async prepare(job: DomainEventJob, tx: DrizzleTx): Promise<PostCommitEffect> {
    const { orderId, userId } = job.payload;
    // Permanent: the payload is byte-identical on every redelivery, so retrying changes nothing.
    if (typeof orderId !== 'string' || typeof userId !== 'string') {
      throw new PermanentError(`order.paid without an orderId/userId to confirm (message ${job.outboxId})`);
    }

    // The event deliberately carries no email address: the outbox is jsonb in Postgres, and a
    // deleted account must not leave its address behind in it. Read on the consumer's own
    // transaction — a second pool connection here would compete with the one this job already holds.
    const user = await this.users.getUserSummary(userId, tx);
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
          { context: LOG_CONTEXT, orderId, messageId: job.outboxId, err: error },
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
