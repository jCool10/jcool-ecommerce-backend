import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type TccBranchOutcome } from '@jcool/metrics-port';
import { captureAction } from '../../domain/payment-order-fence';
import { CANCELLED_PAYMENT_ORDER_STATUSES, PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { callWithKeyRotation, captureKey, type KeyRotationDeps } from '../payment-idempotency-keys';
import type { CaptureOutcome } from '../public/payment-participant.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';

const LOG_CONTEXT = 'CapturePayment';

type Answer = { outcome: CaptureOutcome; branch: TccBranchOutcome };

const REPEAT: Answer = { outcome: 'CAPTURED', branch: 'idempotent' };

/** The gateway call runs outside any transaction; only its confirmed outcome is written back. */
@Injectable()
export class CapturePaymentUseCase {
  private readonly keys: KeyRotationDeps;

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.keys = { txRunner, headers, payments };
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string): Promise<{ outcome: CaptureOutcome }> {
    let answer: Answer;
    try {
      answer = await this.capture(orderId);
    } catch (error) {
      this.metrics.recordTccBranch('payment', 'capture', 'error');
      throw error;
    }
    this.metrics.recordTccBranch('payment', 'capture', answer.branch);
    return { outcome: answer.outcome };
  }

  private async capture(orderId: string): Promise<Answer> {
    const header = await this.headers.find(orderId);
    switch (captureAction(header?.status ?? null)) {
      case 'captured':
        return REPEAT;
      case 'not_capturable':
        return header !== null && (await this.tookMoneyAfterCancel(orderId, header.status))
          ? REPEAT
          : { outcome: 'NOT_CAPTURABLE', branch: 'conflict' };
      case 'capture':
        break;
    }

    // An authorized header admits no new attempt, so the latest payment is the one holding the money.
    const payment = await this.payments.findByOrderId(orderId);
    if (payment?.status !== PaymentStatus.AUTHORIZED || payment.providerIntentId === null) {
      throw new Error(`order ${orderId} is authorized but its latest payment holds nothing to capture`);
    }

    const intentId = payment.providerIntentId;
    const result = await callWithKeyRotation(this.keys, payment, () =>
      this.gateway.capture(intentId, captureKey(payment)),
    );
    if (result.kind === 'captured') return this.recordCaptured(payment);

    await this.txRunner.run(async (tx) => {
      const cancelled = await this.headers.updateStatus(
        tx,
        orderId,
        PaymentOrderStatus.CANCELLED,
        PaymentOrderStatus.AUTHORIZED,
      );
      // Otherwise a cancel got here first, and its void records how the hold ended.
      if (cancelled) {
        await this.payments.updateStatus(payment.id as string, payment.markFailed().status, {
          tx,
          expectedStatus: PaymentStatus.AUTHORIZED,
        });
      }
    });
    return { outcome: 'NOT_CAPTURABLE', branch: 'rejected' };
  }

  /** A cancel leaves its header as it is, so only the payment shows a capture that landed after it. */
  private async tookMoneyAfterCancel(orderId: string, status: PaymentOrderStatus): Promise<boolean> {
    if (!CANCELLED_PAYMENT_ORDER_STATUSES.includes(status)) return false;
    const attempts = await this.payments.findAllByOrderId(orderId);
    return attempts.some((p) => p.status === PaymentStatus.SUCCEEDED);
  }

  private async recordCaptured(payment: Payment): Promise<Answer> {
    const recorded = await this.txRunner.run(async (tx) => {
      const markSucceeded = () =>
        this.payments.updateStatus(payment.id as string, payment.markCaptured().status, {
          tx,
          expectedStatus: PaymentStatus.AUTHORIZED,
        });

      const header = await this.headers.findForUpdate(tx, payment.orderId);
      switch (header?.status) {
        // An overlapping call captured under the same key and recorded it first.
        case PaymentOrderStatus.CAPTURED:
          return 'repeat';
        case PaymentOrderStatus.AUTHORIZED:
          await this.headers.updateStatus(
            tx,
            payment.orderId,
            PaymentOrderStatus.CAPTURED,
            PaymentOrderStatus.AUTHORIZED,
          );
          await markSucceeded();
          return 'captured';
        default:
          // A cancel closed the header first; whichever side records the money raises the alarm.
          return (await markSucceeded()) === null ? 'repeat' : 'conflict';
      }
    });

    if (recorded === 'repeat') return REPEAT;
    if (recorded === 'conflict') {
      this.metrics.recordCaptureConflict();
      this.logger.error(
        { orderId: payment.orderId, paymentId: payment.id },
        'captured an order whose header a cancel had already closed — the buyer is owed a refund',
      );
    }
    return { outcome: 'CAPTURED', branch: 'ok' };
  }
}
