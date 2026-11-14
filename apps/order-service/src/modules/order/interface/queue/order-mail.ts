import type { PinoLogger } from 'nestjs-pino';
import type { MailMessage, MailTransportPort } from '@jcool/platform/mail';
import { type DomainEventJob, PermanentError, type PostCommitEffect } from '@jcool/messaging';
import { toError } from '@jcool/kernel';
import type { MailKind, MetricsPort } from '@jcool/metrics-port';
import type { UserContactPort } from '../../application/ports/user-contact.port';

/** Null rather than a guess when the payload cannot be read: a wrong total is worse than none. */
export function formatTotal(amountMinor: unknown, currency: unknown): string | null {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  // Minor units per major unit read off the currency itself — 1 for VND, 100 for USD.
  return format.format(amountMinor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 0));
}

/**
 * The buyer an order event is mailed to. A directory that could not answer throws through, so the
 * delivery goes back on its retry ladder; anything a redelivery cannot change is permanent.
 */
export async function recipientOf(
  job: DomainEventJob,
  userContact: Pick<UserContactPort, 'find'>,
): Promise<{ orderId: string; email: string }> {
  const { orderId, userId } = job.payload;
  // Permanent: the payload is byte-identical on every redelivery, so retrying changes nothing.
  if (typeof orderId !== 'string' || typeof userId !== 'string') {
    throw new PermanentError(`${job.eventType} without an orderId/userId to confirm (message ${job.outboxId})`);
  }

  // The event deliberately carries no email address: the outbox is jsonb in Postgres, and a
  // deleted account must not leave its address behind in it.
  const user = await userContact.find(userId, new Date(job.occurredAt));
  if (!user) {
    throw new PermanentError(`${job.eventType} for order ${orderId} names a user that no longer exists`);
  }
  return { orderId, email: user.email };
}

interface MailDependencies {
  mailTransport: Pick<MailTransportPort, 'sendMail'>;
  metrics: Pick<MetricsPort, 'recordMailSendFailure'>;
  logger: Pick<PinoLogger, 'error'>;
}

/**
 * Run after the consumer's transaction commits, and never retried: a breaker timeout cannot cancel a
 * message already on the wire, so a redelivery would send it a second time. A failure is counted.
 */
export function sendOnceAfterCommit(
  { mailTransport, metrics, logger }: MailDependencies,
  message: MailMessage,
  failure: { kind: MailKind; context: Record<string, unknown>; message: string },
): PostCommitEffect {
  return async () => {
    try {
      await mailTransport.sendMail(message);
    } catch (error: unknown) {
      metrics.recordMailSendFailure(failure.kind);
      logger.error({ ...failure.context, err: toError(error) }, failure.message);
    }
  };
}
