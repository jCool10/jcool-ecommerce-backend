import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { CancelPaymentUseCase } from './cancel-payment.use-case';
import { heldCharge, RecordAuthorizationUseCase } from './record-authorization.use-case';

const LOG_CONTEXT = 'ReconcileTccPayments';

export interface ReconcileTccInput {
  /** Younger payments are left to the webhook still on its way. */
  staleAfterSec: number;
  batchSize: number;
}

type PaymentOutcome = 'recorded' | 'expired' | 'voided' | 'deferred';

export type ReconcileTccSummary = { scanned: number; errors: number } & Record<PaymentOutcome, number>;

/**
 * The participant's safety net behind the webhook: picks up holds whose event never came, retires
 * attempts Stripe expired, and voids holds left under a cancelled order. Stripe is called with no
 * transaction open, and a failing payment never stops the batch.
 */
@Injectable()
export class ReconcileTccPaymentsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly recordAuthorization: RecordAuthorizationUseCase,
    private readonly cancelPayment: CancelPaymentUseCase,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute({ staleAfterSec, batchSize }: ReconcileTccInput): Promise<ReconcileTccSummary> {
    const stale = await this.payments.findStaleTcc({
      updatedBefore: new Date(Date.now() - staleAfterSec * 1_000),
      limit: batchSize,
    });

    const summary: ReconcileTccSummary = {
      scanned: stale.length,
      recorded: 0,
      expired: 0,
      voided: 0,
      deferred: 0,
      errors: 0,
    };
    for (const payment of stale) {
      try {
        summary[await this.reconcile(payment)]++;
      } catch (error) {
        summary.errors++;
        this.logger.warn({ orderId: payment.orderId, paymentId: payment.id, err: toError(error) }, 'reconcile failed');
      }
    }
    return summary;
  }

  private async reconcile(payment: Payment): Promise<PaymentOutcome> {
    // Only selected under a CANCELLED/FENCED header: a hold nobody will capture.
    if (payment.status === PaymentStatus.AUTHORIZED) {
      await this.cancelPayment.execute(payment.orderId);
      return 'voided';
    }

    const id = payment.id as string;
    const authorization = await this.gateway.retrieveAuthorization(payment.providerSessionId);
    const hold = heldCharge(authorization);
    if (hold) {
      const outcome = await this.recordAuthorization.record(payment, hold, new Date());
      if (outcome === 'recorded' || outcome === 'recorded_late') return 'recorded';
      // A mismatched hold waits for the cancel; it must not hold the head of the queue meanwhile.
      await this.payments.bumpUpdatedAt(id, PaymentStatus.PENDING);
      return 'deferred';
    }
    if (authorization.sessionStatus === 'expired') {
      await this.payments.updateStatus(id, PaymentStatus.EXPIRED, { expectedStatus: PaymentStatus.PENDING });
      return 'expired';
    }
    if (authorization.sessionStatus === 'complete' && authorization.intentStatus === 'canceled') {
      await this.payments.updateStatus(id, PaymentStatus.VOIDED, {
        providerIntentId: authorization.intentId,
        expectedStatus: PaymentStatus.PENDING,
      });
      return 'voided';
    }
    await this.payments.bumpUpdatedAt(id, PaymentStatus.PENDING);
    return 'deferred';
  }
}
