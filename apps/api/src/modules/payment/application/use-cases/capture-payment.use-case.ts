import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { decidePaymentOrderOp } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { withIntentKey } from '../intent-idempotency-key';
import { PAYMENT_GATEWAY, type CaptureIntentResult, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import type { CaptureOutcome } from '../public/payment-participant.port';

const LOG_CONTEXT = 'CapturePayment';

/** Decides on an unlocked read, captures with no transaction open, then writes what Stripe answered. */
@Injectable()
export class CapturePaymentUseCase {
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

  async execute(orderId: string): Promise<CaptureOutcome> {
    const header = await this.headers.find(orderId);
    switch (decidePaymentOrderOp('capture', header?.status ?? null)) {
      case 'idempotent':
        return 'IDEMPOTENT';
      case 'not_capturable':
        return 'NOT_CAPTURABLE';
      case 'conflict':
        this.logger.error({ orderId, header: header?.status ?? null }, 'capture asked before any authorization');
        return 'CONFLICT';
      case 'capture':
        break;
    }

    // The header only reads AUTHORIZED together with the payment it authorized.
    const payment = await this.payments.findByOrderId(orderId);
    if (payment?.status !== PaymentStatus.AUTHORIZED || !payment.providerIntentId) {
      throw new Error(`order ${orderId} reads AUTHORIZED but has no authorized payment`);
    }
    const intentId = payment.providerIntentId;
    const result = await withIntentKey(this.payments, payment, 'capture', (key) =>
      this.gateway.captureIntent(intentId, key),
    );
    return this.transactionRunner.run((tx) => this.settle(tx, payment, result));
  }

  private async settle(tx: DrizzleTx, read: Payment, result: CaptureIntentResult): Promise<CaptureOutcome> {
    const orderId = read.orderId;
    const header = await this.headers.findForUpdate(tx, orderId);
    const payment = await this.payments.findByProviderSessionId(read.providerSessionId, tx);
    if (!header || !payment) throw new Error(`payment ${read.id} or its header vanished under the lock`);

    if (result.kind === 'not_capturable') {
      if (payment.status === PaymentStatus.AUTHORIZED) {
        await this.payments.updateStatus(read.id as string, payment.markFailed().status, { tx });
      }
      await this.headers.update(tx, orderId, { status: PaymentOrderStatus.CANCELLED });
      this.logger.warn({ orderId, paymentId: read.id, intentStatus: result.intentStatus }, 'hold gone before capture');
      return 'NOT_CAPTURABLE';
    }

    if (payment.status === PaymentStatus.SUCCEEDED) return 'IDEMPOTENT';
    if (payment.status !== PaymentStatus.AUTHORIZED) {
      throw new Error(`Stripe captured payment ${read.id}, which reads ${payment.status}`);
    }
    if (header.status === PaymentOrderStatus.CANCELLED) {
      this.metrics.recordCaptureConflict();
      this.logger.error({ orderId, paymentId: read.id }, 'captured money on an order cancelled meanwhile');
    }
    await this.payments.updateStatus(read.id as string, payment.markCaptured().status, { tx });
    await this.headers.update(tx, orderId, { status: PaymentOrderStatus.CAPTURED });
    return 'CAPTURED';
  }
}
