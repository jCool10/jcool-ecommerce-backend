import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PaymentStatus } from '../../domain/payment-status';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';

const LOG_CONTEXT = 'ExpirePaymentSession';

/** Every expired order lands in exactly one bucket. */
export type ExpireSessionResult =
  /** No session was ever opened — the common case for an order that timed out in the cart. */
  | 'no_payment'
  /** A webhook or the reconcile sweep got there first; the money row is already terminal. */
  | 'already_settled'
  /** Settled by a webhook inside our gateway round-trip. */
  | 'raced'
  | 'expired';

/**
 * Closes the money side of an order the reservation sweep expired.
 *
 * That sweep asks the gateway nothing — which is what lets it converge during an outage — so it
 * leaves a live checkout session behind a dead order. Until this runs, a buyer returning to that
 * page pays for stock that has already been sold to someone else. The reconcile sweep cannot pick
 * that up: its queue is orders still `PENDING`, and the expiry already moved this one out.
 */
@Injectable()
export class ExpirePaymentSessionUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly logger: PinoLogger,
  ) {}

  async execute(orderId: string, tx: DrizzleTx): Promise<ExpireSessionResult> {
    const payment = await this.payments.findByOrderId(orderId, tx);
    if (payment === null || payment.id === null) return 'no_payment';

    if (payment.status !== PaymentStatus.PENDING) {
      if (payment.status === PaymentStatus.SUCCEEDED) {
        // The buyer paid in the window between the hold lapsing and the sweep expiring the order.
        // Nothing downstream can repair that — the stock is gone and the money is not — so it is
        // logged as the refund decision it is rather than retried.
        this.logger.error(
          { context: LOG_CONTEXT, orderId, paymentId: payment.id },
          'order expired on TTL but its payment had already succeeded',
        );
      }
      return 'already_settled';
    }

    // Runs inside the consumer's transaction, which by design holds no payment row: `findByOrderId`
    // takes no lock, and the write below comes after. What the transaction does hold is this
    // message's inbox claim, so a gateway that refuses or cannot be reached rolls the claim back and
    // the queue redelivers — the only way the session still gets closed once the gateway recovers.
    await this.gateway.expireSession(payment.providerSessionId);

    const written = await this.payments.updateStatus(payment.id, payment.markExpired().status, {
      tx,
      expectedStatus: PaymentStatus.PENDING,
    });
    if (written === null) {
      // A webhook committed inside the round-trip above. It owns the outcome; the session it settled
      // is now expired at the gateway either way, which is the part that had to happen.
      this.logger.info(
        { context: LOG_CONTEXT, orderId, paymentId: payment.id },
        'payment was settled by a webhook while its session was being expired',
      );
      return 'raced';
    }

    return 'expired';
  }
}
