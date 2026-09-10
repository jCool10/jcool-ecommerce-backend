import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { PaymentStatus } from '../../domain/payment-status';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';

const LOG_CONTEXT = 'ExpirePaymentSession';

/** Why the order stopped being payable. It changes nothing this does — only what the logs say. */
export type ExpireSessionTrigger = 'ttl' | 'cancel';

export type ExpireSessionResult =
  | 'no_payment'
  /** A webhook or the reconcile sweep got there first; the money row is already terminal. */
  | 'already_settled'
  /** Settled by a webhook inside our gateway round-trip. */
  | 'raced'
  /** The session had already taken money. Nothing here can undo that; a human owes a refund. */
  | 'refund_owed'
  | 'expired';

/**
 * Neither the reservation sweep nor a cancel touches the gateway (the sweep cannot, the cancel holds
 * an order row lock), so both leave a live checkout session behind a dead order that the reconcile
 * sweep will never pick up: its queue is orders still `PENDING`.
 */
@Injectable()
export class ExpirePaymentSessionUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {}

  async execute(orderId: string, tx: DrizzleTx, trigger: ExpireSessionTrigger = 'ttl'): Promise<ExpireSessionResult> {
    const payment = await this.payments.findByOrderId(orderId, tx);
    if (payment === null || payment.id === null) return 'no_payment';

    if (payment.status !== PaymentStatus.PENDING) {
      if (payment.status === PaymentStatus.SUCCEEDED) {
        // The buyer paid between the order dying and this running. Nothing downstream repairs that.
        this.refundOwed(orderId, payment.id, trigger, 'its payment had already succeeded');
        return 'refund_owed';
      }
      return 'already_settled';
    }

    // Runs inside the consumer's transaction, which by design holds no payment row — what it holds is
    // this message's inbox claim, so a gateway that refuses or cannot be reached rolls the claim back
    // and the queue redelivers, which is the only way the session gets closed once it recovers.
    const outcome = await this.gateway.expireSession(payment.providerSessionId);
    if (outcome === 'already_completed') {
      // Acknowledged, not retried: no redelivery un-pays a session, and this is the only signal there
      // is if the webhook never arrives. "Submitted", not "paid": an async method can still be
      // clearing behind a `complete` session.
      this.refundOwed(orderId, payment.id, trigger, 'its checkout session had already been submitted for payment');
      return 'refund_owed';
    }
    // `already_closed` continues: an unpayable session is what this needed, whether this call closed
    // it or an earlier attempt did before its transaction rolled back.

    const written = await this.payments.updateStatus(payment.id, payment.markExpired().status, {
      tx,
      expectedStatus: PaymentStatus.PENDING,
    });
    if (written === null) {
      // A webhook committed inside the round-trip above. It owns the outcome; the session it settled
      // is now expired at the gateway either way, which is the part that had to happen.
      this.logger.info(
        { context: LOG_CONTEXT, orderId, paymentId: payment.id, trigger },
        'payment was settled by a webhook while its session was being expired',
      );
      return 'raced';
    }

    return 'expired';
  }

  // `trigger` rides as a field, not in the message, so filtering for this line needs one spelling.
  private refundOwed(orderId: string, paymentId: string, trigger: ExpireSessionTrigger, because: string): void {
    this.metrics.recordRefundOwed('expire_session');
    this.logger.error(
      { context: LOG_CONTEXT, orderId, paymentId, trigger },
      `order will not be fulfilled but ${because} — refund owed`,
    );
  }
}
