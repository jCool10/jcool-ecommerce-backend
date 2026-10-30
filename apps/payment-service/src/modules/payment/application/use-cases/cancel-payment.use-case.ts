import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleTx } from '../../../../database';
import { decidePaymentOrderOp } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { withIntentKey } from '../intent-idempotency-key';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import type { CancelOutcome } from '../public/payment-participant.port';

const LOG_CONTEXT = 'CancelPayment';

/** Where Stripe left the attempt once the cancel released it. */
type Released = { to: 'EXPIRED' } | { to: 'VOIDED'; intentId?: string } | { to: 'CAPTURED' };

type Flipped = { outcome: CancelOutcome; attempt: Payment | null };

/**
 * Flip-then-act: tx1 flips the header, Stripe is called with no transaction open, tx2 records what
 * Stripe did. Once tx1 commits, every later open is CLOSED, so whatever this cancel releases stays
 * released; a failure after the flip is retried into the CANCELLED row and rescans.
 */
@Injectable()
export class CancelPaymentUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string): Promise<CancelOutcome> {
    const { outcome, attempt } = await this.transactionRunner.run((tx) => this.flip(tx, orderId));
    if (!attempt) return outcome;

    const released = await this.release(attempt);
    const conflict = await this.transactionRunner.run((tx) => this.record(tx, attempt, released));
    return conflict ? 'CAPTURED_CONFLICT' : outcome;
  }

  private async flip(tx: DrizzleTx, orderId: string): Promise<Flipped> {
    let header = await this.headers.findForUpdate(tx, orderId);
    let fenced = false;
    if (!header) {
      // Losing the insert to a concurrent open just means we cancel what it opened.
      fenced = await this.headers.insertFenced(tx, orderId);
      header = await this.headers.findForUpdate(tx, orderId);
      if (!header) throw new Error(`payment_orders header of order ${orderId} lost an insert race yet cannot be read`);
    }

    let outcome: CancelOutcome;
    switch (decidePaymentOrderOp('cancel', header.status)) {
      case 'captured_conflict':
        this.reportCaptureConflict(orderId);
        return { outcome: 'CAPTURED_CONFLICT', attempt: null };
      case 'cancel':
        await this.headers.update(tx, orderId, { status: PaymentOrderStatus.CANCELLED });
        outcome = 'CANCELLED';
        break;
      case 'fence':
      case 'rescan':
        outcome = fenced ? 'FENCED' : 'IDEMPOTENT';
        break;
    }

    const active = await this.payments.findActiveByOrderIdForUpdate(tx, orderId);
    const releasable = active?.status === PaymentStatus.PENDING || active?.status === PaymentStatus.AUTHORIZED;
    return { outcome, attempt: releasable ? active : null };
  }

  private async release(attempt: Payment): Promise<Released> {
    if (attempt.status === PaymentStatus.AUTHORIZED) {
      return this.voidHold(attempt, attempt.providerIntentId as string);
    }

    const expired = await this.gateway.expireSession(attempt.providerSessionId);
    if (expired !== 'already_completed') return { to: 'EXPIRED' };

    // The buyer got through before the expire did: whatever the card holds has to be let go.
    const authorization = await this.gateway.retrieveAuthorization(attempt.providerSessionId);
    const intentId = authorization.intentId;
    switch (authorization.intentStatus) {
      case 'requires_capture':
        return this.voidHold(attempt, intentId as string);
      case 'canceled':
        return { to: 'VOIDED', intentId };
      case 'succeeded':
        return { to: 'CAPTURED' };
      default:
        throw new Error(
          `session ${attempt.providerSessionId} completed but its intent reads ${authorization.intentStatus ?? 'nothing'}`,
        );
    }
  }

  private async voidHold(attempt: Payment, intentId: string): Promise<Released> {
    const outcome = await withIntentKey(this.payments, attempt, 'void', (key) =>
      this.gateway.voidIntent(intentId, key),
    );
    return outcome === 'already_captured' ? { to: 'CAPTURED' } : { to: 'VOIDED', intentId };
  }

  /** True when the money turned out to be captured. CAS throughout: a newer write is never undone. */
  private async record(tx: DrizzleTx, attempt: Payment, released: Released): Promise<boolean> {
    const orderId = attempt.orderId;
    await this.headers.findForUpdate(tx, orderId);
    const payment = await this.payments.findByProviderSessionId(attempt.providerSessionId, tx);
    if (!payment) throw new Error(`payment ${attempt.id} vanished under the lock`);
    const id = payment.id as string;

    switch (released.to) {
      case 'EXPIRED':
        await this.payments.updateStatus(id, PaymentStatus.EXPIRED, { expectedStatus: PaymentStatus.PENDING, tx });
        return false;
      case 'VOIDED':
        if (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.AUTHORIZED) {
          await this.payments.updateStatus(id, PaymentStatus.VOIDED, {
            providerIntentId: released.intentId,
            expectedStatus: payment.status,
            tx,
          });
        }
        return false;
      case 'CAPTURED':
        if (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.AUTHORIZED) {
          await this.payments.updateStatus(id, PaymentStatus.SUCCEEDED, { expectedStatus: payment.status, tx });
        }
        await this.headers.update(tx, orderId, { status: PaymentOrderStatus.CAPTURED });
        this.reportCaptureConflict(orderId);
        return true;
    }
  }

  private reportCaptureConflict(orderId: string): void {
    this.metrics.recordCaptureConflict();
    this.logger.error({ orderId }, 'cancel found the money already captured');
  }
}
